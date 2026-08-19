import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { requireAdmin } from "./auth.js";
import { listInboxThreadsPage, getThreadFull } from "./gmail.js";
import {
  getInboxItemByThreadId, getAllClientAliases, matchProjectCandidates,
  getProjectById,
} from "./db.js";
import { getTimerEntriesForProject } from "./timers.js";
import { runsOnDisk, readRunResult } from "./spark.js";
import {
  gateForSession, deliver, MAX_SEND_CHARS, sessionPlanFile, PLANS_DIR,
} from "./session_gate.js";
import { sessionExists, spawnSession } from "./runroom_build.js";

// Mailroom — Phase 2 (the view): browse the inbox Gmail-style, select a
// thread, get an automatic roundup, converse toward an action. Same
// philosophy as runrooms: files are the page, the server reads, ONLY the
// standing `mailroom` session writes ~/OpenDia/mailroom/threads/<id>.json.
//
// Unlike runrooms (one room per tmux session), the mailroom is a SINGLE
// standing session bound to a fixed tmux name — the view has many threads
// but one conversation. Every route here is admin-only: requireLinnfluxUser
// already gates the whole app (index.js), so each route adds requireAdmin.
//
// Phase C (this build) is converse-only: no route here ever creates a Gmail
// draft. `proposed_draft`/`handled` are read straight through from the state
// file (whatever shape a future phase-D session writes) but nothing in this
// module or the paired `/mailroom view` skill mode calls gmail_create_draft.

const HOME = process.env.HOME || "/home/linnflux";
const MAILROOM_DIR = resolve(HOME, "OpenDia", "mailroom");
const THREADS_DIR = resolve(MAILROOM_DIR, "threads");
const SENDS_LOG = resolve(MAILROOM_DIR, "sends.log");
const MAILROOM_SESSION = "mailroom";
const MAILROOM_BRIEF = resolve(HOME, "OpenDia", "handoffs", "mailroom-view.md");

// Thread ids are path segments (threads/<id>.json) — same discipline
// runrooms.js's SESSION_RE gives session names, so a crafted :threadId can
// never traverse out of THREADS_DIR. Gmail thread ids are lowercase hex.
const THREAD_ID_RE = /^[0-9a-f]{5,24}$/;

// ── Sender -> client resolution ─────────────────────────────────────────────
// Ports inbox_db.py's lookup_alias: priority email > domain > substring (in
// subject). Kept in this module rather than db.js because it is Mailroom's
// own fallback path — the inbox pipeline's Stage A already resolves this for
// anything that went through it (see getInboxItemByThreadId below).
function extractEmailAndDomain(fromHeader) {
  const m = /<([^>]+)>/.exec(fromHeader || "");
  const email = (m ? m[1] : (fromHeader || "")).trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : "";
  return { email, domain };
}

const ALIAS_PRIORITY = { email: 1, domain: 2, substring: 3 };

function lookupAlias(fromHeader, subject) {
  const { email, domain } = extractEmailAndDomain(fromHeader);
  const subjectLower = (subject || "").toLowerCase();
  const sorted = getAllClientAliases()
    .slice()
    .sort((a, b) => (ALIAS_PRIORITY[a.match_type] || 9) - (ALIAS_PRIORITY[b.match_type] || 9));
  for (const row of sorted) {
    const mv = (row.match_value || "").toLowerCase();
    if (row.match_type === "email" && mv === email) return row;
    if (row.match_type === "domain" && mv === domain) return row;
    if (row.match_type === "substring" && mv && subjectLower.includes(mv)) return row;
  }
  return null;
}

const KEYMAP = { esc: "Escape", enter: "Enter", up: "Up", down: "Down", left: "Left", right: "Right", space: "Space" };

// The freshness floor sessionPlanFile needs, for a standing session that has
// no plan.json to read `created` from. Session name prefixes truncate short
// ("mail" covers both a "mailroom-ui" build session's own plan AND the
// standing "mailroom" session's), so without a floor a much-older same-
// prefix plan could outrank the real one whenever the standing session
// hasn't reached its own ExitPlanMode yet. tmux's own session_created is the
// natural equivalent of a runroom's `created` timestamp here.
function tmuxSessionCreatedIso(tmuxSession) {
  try {
    const epoch = execFileSync(
      "tmux", ["display-message", "-p", "-t", tmuxSession, "#{session_created}"],
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    const ms = Number(epoch) * 1000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

export function registerMailroomRoutes(app) {
  app.get("/api/mailroom/threads", requireAdmin, async (req, res) => {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 5));
    try {
      res.json(await listInboxThreadsPage(offset, limit));
    } catch (e) {
      res.status(502).json({ error: `gmail fetch failed: ${e.message}` });
    }
  });

  app.get("/api/mailroom/threads/:threadId", requireAdmin, async (req, res) => {
    const { threadId } = req.params;
    if (!THREAD_ID_RE.test(threadId)) return res.status(400).json({ error: "bad thread id" });
    let full;
    try {
      full = await getThreadFull(threadId);
    } catch (e) {
      return res.status(502).json({ error: `gmail fetch failed: ${e.message}` });
    }
    if (!full.ok) return res.status(full.status === 404 ? 404 : 502).json({ error: "thread fetch failed", status: full.status });
    res.json(full);
  });

  // Instant deterministic facts — no AI, sub-second. Resolution order:
  // 1. inbox_items by thread_id (Stage A already resolved it, if this thread
  //    went through the inbox pipeline) — nothing to guess.
  // 2. Otherwise resolve the sender through client_aliases, then
  //    matchProjectCandidates (not matchProject: it falls back to a relaxed
  //    client-only pass and returns options where matchProject returns null).
  app.get("/api/mailroom/threads/:threadId/context", requireAdmin, async (req, res) => {
    const { threadId } = req.params;
    if (!THREAD_ID_RE.test(threadId)) return res.status(400).json({ error: "bad thread id" });

    let project = null;
    let candidates = [];
    const inboxItem = getInboxItemByThreadId(threadId);
    if (inboxItem?.project_id) {
      project = getProjectById(inboxItem.project_id);
    }

    if (!project) {
      let full;
      try {
        full = await getThreadFull(threadId);
      } catch {
        full = { ok: false };
      }
      if (full.ok && full.messages.length) {
        const first = full.messages[0];
        const alias = lookupAlias(first.from, first.subject);
        if (alias) {
          candidates = matchProjectCandidates(alias.client_hint, alias.division_hint || "", first.subject, 3);
          if (candidates.length) project = candidates[0]; // best guess; candidates[] stays for a future picker
        }
      }
    }

    let recentTime = [];
    let spark = null;
    if (project) {
      const fresh = getProjectById(project.id);
      if (fresh) project = fresh;
      // Matches on the CARD NAME appearing in an entry's project/task field —
      // "recent time on this card", not "on this client" at large.
      recentTime = await getTimerEntriesForProject(project, 5);
      const entry = runsOnDisk(project.id).find((e) => e.status !== "interrupted");
      if (entry) {
        const r = readRunResult(entry);
        if (r) spark = { where_it_stands: r.where_it_stands, next_step: r.next_step, certitude: r.certitude };
      }
    }

    res.json({
      thread_id: threadId,
      project: project ? {
        id: project.id, name: project.name, status: project.status,
        next_step: project.next_step, company_name: project.company_name,
        division: project.division,
      } : null,
      candidates: candidates.map((c) => ({
        id: c.id, name: c.name, company_name: c.company_name, division: c.division, status: c.status,
      })),
      recent_time: recentTime,
      spark,
    });
  });

  // Session-written state file. 404 means "not investigated yet" — the
  // server never writes this, only the standing session does.
  app.get("/api/mailroom/threads/:threadId/state", requireAdmin, (req, res) => {
    const { threadId } = req.params;
    if (!THREAD_ID_RE.test(threadId)) return res.status(400).json({ error: "bad thread id" });
    const file = resolve(THREADS_DIR, `${threadId}.json`);
    if (!existsSync(file)) return res.status(404).json({ error: "not investigated yet" });
    try {
      res.json(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // A half-written file (the session updates it in place) is transient,
      // not an error — same tolerance runrooms.js's readPlan uses.
      res.status(404).json({ error: "not investigated yet" });
    }
  });

  app.get("/api/mailroom/session", requireAdmin, (_req, res) => {
    if (!sessionExists(MAILROOM_SESSION)) return res.json({ exists: false });
    const gate = gateForSession(MAILROOM_SESSION);
    // A plan-approval dialog gets the real plan document: the pane can only
    // ever show one page of Claude Code's self-redrawing plan box, so the
    // scrollback fallback (gate.dialog.context_full) genuinely cannot
    // contain a plan of any length. Same enrichment as runrooms.js's detail
    // route — see tmuxSessionCreatedIso for why the freshness floor matters
    // here specifically.
    if (gate.dialog?.options?.some((o) => /approve/i.test(o.label))) {
      const found = sessionPlanFile(MAILROOM_SESSION, tmuxSessionCreatedIso(MAILROOM_SESSION));
      if (found) {
        try {
          gate.dialog.plan_file = found.name;
          gate.dialog.plan_md = readFileSync(resolve(PLANS_DIR, found.name), "utf8").slice(0, 60_000);
        } catch {}
      }
    }
    res.json({ exists: true, gate });
  });

  // Fresh spawn only, deliberately no resume: the mailroom's memory IS the
  // thread state files, so a fresh session re-reads what it needs. See
  // mailroom-ui-plan.md's 2026-08-19 decision — dispatch_spawn.sh has no
  // resume flag, and a failed `claude --resume` in a detached tmux leaves a
  // dead pane this route could not detect anyway.
  //
  // --yolo (acceptEdits): decided 2026-08-19, after Nick's first live test
  // hit dispatch_spawn.sh's plan-mode-by-default head-on — a cold spawn's
  // very first act was planning its OWN entry sequence and pausing for
  // approval, unrelated to and blocking whatever thread triggered the spawn.
  // The skill's hard rules already forbid every consequential action in this
  // phase (never gmail_send, never gmail_create_draft), so there is nothing
  // acceptEdits newly exposes — it only removes a one-time approval gate
  // that had nothing to approve.
  app.post("/api/mailroom/session/ensure", requireAdmin, (_req, res) => {
    if (sessionExists(MAILROOM_SESSION)) return res.json({ session: MAILROOM_SESSION, spawned: false });
    if (!existsSync(MAILROOM_BRIEF)) return res.status(500).json({ error: `brief missing: ${MAILROOM_BRIEF}` });
    let final;
    try {
      final = spawnSession(MAILROOM_SESSION, MAILROOM_BRIEF, ["--yolo"]);
    } catch (e) {
      return res.status(502).json({ error: `spawn failed: ${e.message}` });
    }
    // The fixed name should never collide — nothing else uses "mailroom".
    // If dispatch_spawn.sh suffixed it anyway, something already holds the
    // name; fail loudly rather than binding the view to a session it did
    // not mean.
    if (final !== MAILROOM_SESSION) {
      return res.status(500).json({ error: `spawned as "${final}", not "${MAILROOM_SESSION}" — a stray session may already hold the name` });
    }
    res.json({ session: MAILROOM_SESSION, spawned: true });
  });

  app.post("/api/mailroom/threads/:threadId/select", requireAdmin, (req, res) => {
    const { threadId } = req.params;
    if (!THREAD_ID_RE.test(threadId)) return res.status(400).json({ error: "bad thread id" });
    // Same control-char stripping the image route applies to captions — the
    // subject rides through client-supplied JSON before it becomes a single
    // literal line typed into the session.
    let subject = typeof req.body?.subject === "string" ? req.body.subject : "";
    subject = subject.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
    mkdirSync(MAILROOM_DIR, { recursive: true });
    const text = `[mailroom] selected thread ${threadId} "${subject}" — run the roundup`;
    const { status, body } = deliver({
      tmuxSession: MAILROOM_SESSION, logPath: SENDS_LOG, text, user: req.user, tag: "select",
    });
    res.status(status).json(body);
  });

  // Suggestion buttons are session-authored ({id, label, kind} in the state
  // file); the canned message text for accepting one lives HERE, not in the
  // client, so the button/session contract has exactly one author — the same
  // rule runrooms.js's ACTIONS registry follows.
  app.post("/api/mailroom/threads/:threadId/suggestion", requireAdmin, (req, res) => {
    const { threadId } = req.params;
    if (!THREAD_ID_RE.test(threadId)) return res.status(400).json({ error: "bad thread id" });
    const id = typeof req.body?.id === "string" ? req.body.id.slice(0, 100) : "";
    if (!id) return res.status(400).json({ error: "missing suggestion id" });
    mkdirSync(MAILROOM_DIR, { recursive: true });
    const text = `[mailroom] suggestion ${id} accepted for thread ${threadId}`;
    const { status, body } = deliver({
      tmuxSession: MAILROOM_SESSION, logPath: SENDS_LOG, text, user: req.user, tag: "suggestion",
    });
    res.status(status).json(body);
  });

  app.post("/api/mailroom/send", requireAdmin, (req, res) => {
    let text = typeof req.body?.text === "string" ? req.body.text : "";
    // Same literal-text discipline as runrooms.js's send route: keep
    // newlines (they insert, not submit, in the TUI input box), strip every
    // other control character, cap the size.
    text = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
    if (!text) return res.status(400).json({ error: "empty message" });
    if (text.length > MAX_SEND_CHARS) return res.status(400).json({ error: `over ${MAX_SEND_CHARS} chars` });
    mkdirSync(MAILROOM_DIR, { recursive: true });
    const { status, body } = deliver({
      tmuxSession: MAILROOM_SESSION, logPath: SENDS_LOG, text, user: req.user, tag: null,
    });
    res.status(status).json(body);
  });

  // Answer the dialog the standing session is currently showing. Mirrors
  // runrooms.js's dialog route against a fixed session name instead of a
  // per-room one; not pulled into session_gate.js because the route's own
  // validation (fingerprint match, nav-key exemptions) is caller-specific,
  // not shared gate logic.
  app.post("/api/mailroom/dialog", requireAdmin, (req, res) => {
    const { choice, fingerprint } = req.body || {};
    if (!/^([1-9]|enter|esc|up|down|left|right|space)$/.test(String(choice))) {
      return res.status(400).json({ error: "bad choice" });
    }
    const isNav = !/^[1-9]$/.test(String(choice));
    const gate = gateForSession(MAILROOM_SESSION);
    if (gate.reason !== "dialog-open" || !gate.dialog) {
      return res.status(409).json({ error: "no dialog on screen", gate });
    }
    if (!isNav && (!fingerprint || fingerprint !== gate.dialog.fingerprint)) {
      return res.status(409).json({ error: "dialog changed", gate });
    }
    if (/^[1-9]$/.test(String(choice)) && !gate.dialog.options.some((o) => o.n === Number(choice))) {
      return res.status(400).json({ error: "no such option", gate });
    }
    const key = KEYMAP[choice] || String(choice);
    try {
      execFileSync("tmux", ["send-keys", "-t", MAILROOM_SESSION, key], { timeout: 3000 });
    } catch (e) {
      return res.status(502).json({ error: `send failed: ${e.message}` });
    }
    try {
      mkdirSync(MAILROOM_DIR, { recursive: true });
      const label = choice === "esc" || choice === "enter" ? choice
        : gate.dialog.options.find((o) => o.n === Number(choice))?.label;
      appendFileSync(SENDS_LOG, `${new Date().toISOString()} ${req.user?.login || "?"} [dialog]: ${choice} (${label})\n`);
    } catch {}
    res.json({ answered: true });
  });
}
