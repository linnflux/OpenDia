import { readFileSync, readdirSync, existsSync, appendFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { terminalHolderFor } from "./terminal.js";

// Runrooms — read-only API over ~/OpenDia/runrooms/<tmux-session>/plan.json.
//
// The files are written and maintained by the Claude session that owns the
// plan (the /runroom skill's standing contract: file before prose), so this
// module never writes. There is deliberately no registry: the directory IS
// the registry, exactly one live plan.json per session, which leaves nothing
// to drift out of sync after a crash.
//
// Base auth only (requireLinnfluxUser, applied app-wide) — runrooms are work
// instructions for whichever operator is walking the plan, so unlike Rooms
// they must be visible to non-admins.

const RUNROOMS_DIR = resolve(process.env.HOME, "OpenDia", "runrooms");

// One room per tmux session; session names come from tmux via od-go/dispatch
// and are pathless slugs. Reject anything else so a crafted :session can
// never traverse out of RUNROOMS_DIR.
const SESSION_RE = /^[A-Za-z0-9._-]+$/;

function readPlan(session) {
  const p = resolve(RUNROOMS_DIR, session, "plan.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // A half-written file (the session updates it in place) is a transient
    // state, not an error worth surfacing; the next poll gets the full write.
    return null;
  }
}

// ── The modal gate ─────────────────────────────────────────────────────────
// "Is it safe to type into this session right now?" is a question about what
// the TUI is showing, and the transcript cannot answer it: measured across
// every session on this box, `mode` records are always "normal" (5,382 of
// them, one value) and `permission-mode` records the session's permission
// SETTING, not whether a dialog is open. So this one check reads the screen —
// the single place scraping is correct, because the dialog IS a screen
// artifact. The data model stays on structured files.
//
// Chrome, captured empirically from a probe session (2026-08-12):
//   idle     bare "❯" input line above the bottom rule; "? for shortcuts"
//   working  the input line is STILL present; "esc to interrupt" — typed text
//            queues, so sending mid-turn is safe
//   dialog   trust prompt / permission prompt / AskUserQuestion all replace
//            the input box with numbered options, cursor on one: "❯ 1. Yes"
//
// Echoed user messages also render with a "❯ " prefix in scrollback, so the
// presence of "❯" means nothing by itself. Two structural facts held across
// every captured state:
//   1. an OPTION CURSOR is "❯ <number>." — dialogs only;
//   2. the INPUT BOX is the one "❯" line sandwiched DIRECTLY between two
//      horizontal rules — scrollback echoes sit between conversation lines,
//      never between rules.
// Send is allowed iff the sandwiched input line exists, is empty — bare "❯",
// or the fresh-session welcome placeholder ("❯ Try \"…\"") — and no option
// cursor is visible. An input line with real text in it is someone's
// half-typed draft, and we never append to a draft. Fail closed.
const OPTION_CURSOR_RE = /^\s*❯\s+\d+\.\s/;
const RULE_RE = /─{10,}/;

function classifyPane(pane) {
  const lines = pane.split("\n");
  if (lines.slice(-40).some((l) => OPTION_CURSOR_RE.test(l))) {
    return { ok: false, reason: "dialog-open" };
  }
  const nonBlank = (i, dir) => {
    for (let j = i + dir; j >= 0 && j < lines.length; j += dir) {
      if (lines[j].trim() !== "") return lines[j];
    }
    return "";
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("❯")) continue;
    if (!RULE_RE.test(nonBlank(i, -1)) || !RULE_RE.test(nonBlank(i, +1))) continue;
    const content = lines[i].slice(1).trim();
    if (content === "" || content.startsWith('Try "')) return { ok: true };
    return { ok: false, reason: "no-input-box", detail: "draft in input box" };
  }
  return { ok: false, reason: "no-input-box" };
}

function gateForSession(tmuxSession) {
  let pane;
  try {
    pane = execFileSync("tmux", ["capture-pane", "-t", tmuxSession, "-p"],
                        { encoding: "utf8", timeout: 3000 });
  } catch {
    return { ok: false, reason: "session-gone" };
  }
  const verdict = classifyPane(pane);
  if (!verdict.ok) return verdict;
  const holder = terminalHolderFor(tmuxSession);
  if (holder) return { ok: false, reason: "terminal-held", holder };
  return { ok: true };
}

const MAX_SEND_CHARS = 4000;

export function registerRunroomRoutes(app) {
  app.get("/api/runrooms", (_req, res) => {
    let sessions = [];
    try {
      sessions = readdirSync(RUNROOMS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return res.json([]); // no runrooms dir yet — an empty list, not a 500
    }
    const rooms = sessions
      .map((s) => ({ session: s, plan: readPlan(s) }))
      .filter((r) => r.plan)
      .map(({ session, plan }) => ({
        session,
        title: plan.title,
        status: plan.status,
        card_id: plan.card_id,
        card_name: plan.card_name,
        company: plan.company,
        division: plan.division,
        created: plan.created,
        current_step: plan.current_step,
        steps_total: (plan.steps || []).length,
        steps_done: (plan.steps || []).filter((s) => s.state === "done").length,
      }))
      // Active rooms first, newest first within each group.
      .sort((a, b) =>
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1)
        || (b.created || "").localeCompare(a.created || ""));
    res.json(rooms);
  });

  app.get("/api/runrooms/:session", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    // Piggyback the gate on the poll the page already makes, so the composer
    // can disable itself the moment a dialog opens — before a send bounces.
    res.json({ ...plan, gate: plan.status === "active" ? gateForSession(plan.tmux_session) : { ok: false, reason: plan.status } });
  });

  app.post("/api/runrooms/:session/send", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });

    let text = typeof req.body?.text === "string" ? req.body.text : "";
    // Literal text only: keep newlines (they insert, not submit, in the TUI
    // input box), strip every other control character so nothing can smuggle
    // key sequences, and cap the size.
    text = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
    if (!text) return res.status(400).json({ error: "empty message" });
    if (text.length > MAX_SEND_CHARS) return res.status(400).json({ error: `over ${MAX_SEND_CHARS} chars` });

    // Gate at send time, not just at poll time — the screen may have changed
    // in the seconds since the composer last looked.
    const gate = gateForSession(plan.tmux_session);
    if (!gate.ok) return res.status(409).json({ error: "gate closed", gate });

    try {
      // -l = literal (no key-name interpretation); args array = no shell.
      execFileSync("tmux", ["send-keys", "-t", plan.tmux_session, "-l", text], { timeout: 3000 });
      execFileSync("tmux", ["send-keys", "-t", plan.tmux_session, "Enter"], { timeout: 3000 });
    } catch (e) {
      return res.status(502).json({ error: `send failed: ${e.message}` });
    }

    // Audit next to the plan: who said what, when, from the room.
    try {
      appendFileSync(resolve(RUNROOMS_DIR, session, "sends.log"),
        `${new Date().toISOString()} ${req.user?.login || "?"}: ${text.replace(/\n/g, "\\n")}\n`);
    } catch {}
    res.json({ sent: true });
  });
}
