import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import express from "express";
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

// Last write to a session's plan.json — the room's staleness signal. A live
// session that isn't updating the file and a dead one look identical without
// this; surfacing the age lets the page say which story it's telling.
function planMtime(session) {
  try {
    return statSync(resolve(RUNROOMS_DIR, session, "plan.json")).mtimeMs;
  } catch {
    return null;
  }
}

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

// When a dialog is up, pull it apart so the page can render it as buttons
// (build step 5). Anchored on the option-cursor line ("❯ N.") — the one
// marker that only dialogs produce — then expanded over the contiguous
// numbered-option block around it. Context is what sits above the options up
// to the nearest rule: the question, the command being approved, the trust
// text. The fingerprint hashes what was parsed, so an answer can be refused
// if the dialog changed between the page's poll and the click — the
// dialog-race twin of the action endpoint's stale-step guard.
const OPTION_LINE_RE = /^\s*❯?\s*\d+\.\s/;

function parseDialog(lines) {
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_CURSOR_RE.test(lines[i])) { cursor = i; break; }
  }
  if (cursor < 0) return null;
  let start = cursor, end = cursor;
  while (start - 1 >= 0 && OPTION_LINE_RE.test(lines[start - 1])) start--;
  while (end + 1 < lines.length && OPTION_LINE_RE.test(lines[end + 1])) end++;
  const options = [];
  for (let i = start; i <= end; i++) {
    const m = lines[i].match(/^\s*(❯)?\s*(\d+)\.\s+(.*)$/);
    if (m) options.push({ n: Number(m[2]), label: m[3].trim(), selected: !!m[1] });
  }
  if (options.length === 0) return null;
  const context = [];
  for (let i = start - 1; i >= 0 && context.length < 12; i--) {
    if (RULE_RE.test(lines[i])) break;
    if (lines[i].trim() !== "") context.unshift(lines[i].trim());
  }
  const hint = ((lines[end + 1] || "").trim() || (lines[end + 2] || "").trim()) || "";
  // Form-style dialogs need different driving than one-shot menus. Two tells:
  // the multi-question tab strip above the options ("← ☐ Scope ✔ Submit →"),
  // and checkbox markers in the option labels themselves ("[ ]"/"[✔]") — the
  // latter navigates with arrows and toggles with Enter, and number keys are
  // inert. The footer hint "Enter to select" is the belt to that suspenders.
  const multi = context.some((l) => /Submit/.test(l) && /[←→☐✔☑]/.test(l))
    || options.some((o) => /^\[[ ✔✓xX]\]/.test(o.label))
    || /Enter to select/i.test(hint);
  const fingerprint = createHash("sha1")
    .update(JSON.stringify({ context, options: options.map((o) => [o.n, o.label]) }))
    .digest("hex").slice(0, 16);
  return { context, options, hint, multi, fingerprint };
}

// SGR helpers for the suggestion problem: Claude Code ghosts a SUGGESTED
// prompt into the idle input box as dim text ("\x1b[2m…"). A colorless
// capture cannot tell it from a typed draft — measured live, the suggestion
// is dim-wrapped and typed text is not. So the gate captures WITH escapes,
// judges the input line after deleting dim spans, and hands everything else
// a plain-stripped copy.
const SGR_RE = /\x1b\[[0-9;]*m/g;
const DIM_SPAN_RE = /\x1b\[2m[^\x1b]*(?:\x1b\[(?:0|22)m)?/g;

function classifyPane(escPane) {
  const escLines = escPane.split("\n");
  const lines = escLines.map((l) => l.replace(SGR_RE, ""));
  if (lines.slice(-40).some((l) => OPTION_CURSOR_RE.test(l))) {
    return { ok: false, reason: "dialog-open", dialog: parseDialog(lines) };
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
    // Emptiness is judged with dim spans DELETED: a ghosted suggestion is
    // not a draft. Whatever survives dim-stripping was really typed.
    const typed = escLines[i].replace(DIM_SPAN_RE, "").replace(SGR_RE, "");
    const content = typed.replace(/^[^❯]*❯/, "").trim();
    if (content === "" || content.startsWith('Try "')) return { ok: true };
    return { ok: false, reason: "no-input-box", detail: "draft in input box" };
  }
  return { ok: false, reason: "no-input-box" };
}

// Is the session mid-turn, and on what? The TUI's own spinner line says:
// "✢ Caramelizing… (45s · ↓ 1.2k tokens)" — animated glyph, a verb ending in
// a real ellipsis, then timing meta. Lifting the session's actual verb beats
// inventing a generic "thinking" — the page shows what the terminal shows.
// Fallback: the status line carries "esc to interrupt" whenever a turn is
// running, even if the spinner line scrolled or changed shape.
const SPINNER_RE = /^\s*\S{1,2}\s+([A-Z][^(…]{0,40}…)\s*(?:\(([^)]*)\))?/;

function detectWorking(lines) {
  const tail = lines.slice(-15);
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(SPINNER_RE);
    if (m) return { verb: m[1], meta: m[2] || "" };
  }
  if (tail.some((l) => l.includes("esc to interrupt"))) return { verb: "Working\u2026", meta: "" };
  return null;
}

// The short context parseDialog extracts (≤12 lines, stops at any rule line)
// is right for permission prompts but useless for a plan-approval dialog: the
// TUI wraps the plan body in a ruled box, so the walk stops before a single
// line of the plan — the operator gets Approve buttons for a document the
// room never shows. This second, wider capture pulls scrollback and takes
// everything between the previous input prompt and the option list, box and
// all, so the room can render what is actually being approved.
function fullDialogContext(tmuxSession) {
  let pane;
  try {
    pane = execFileSync("tmux", ["capture-pane", "-t", tmuxSession, "-p", "-S", "-250"],
                        { encoding: "utf8", timeout: 3000 });
  } catch {
    return null;
  }
  const lines = pane.replace(SGR_RE, "").split("\n");
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_CURSOR_RE.test(lines[i])) { cursor = i; break; }
  }
  if (cursor < 0) return null;
  let start = cursor;
  while (start - 1 >= 0 && OPTION_LINE_RE.test(lines[start - 1])) start--;
  const out = [];
  for (let i = start - 1; i >= 0 && out.length < 160; i--) {
    if (lines[i].trimStart().startsWith("❯")) break;   // previous input box
    out.unshift(lines[i].replace(/\s+$/, ""));
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? out : null;
}

// The TUI's plan-approval dialog is a self-redrawing scrollable box: the
// terminal buffer only ever holds one viewport page, so no pane capture can
// show a long plan. The plan itself is a FILE, and a dispatched session's
// plan file is named from its first prompt — "Read ~/OpenDia/handoffs/
// <session>.md and follow it…" slugs to read-…-handoffs-<truncated-session>-
// <word>-<word>.md. Strip prefix and the two-word random suffix; what
// remains is a (possibly mid-word truncated) prefix of the session name.
const PLANS_DIR = resolve(process.env.HOME, ".claude", "plans");
const PLAN_FILE_RE = /^read-.*-handoffs-(.+)-[a-z]+-[a-z]+\.md$/;

function sessionPlanFile(session, createdIso) {
  let entries;
  try {
    entries = readdirSync(PLANS_DIR);
  } catch {
    return null;
  }
  const slug = String(session).toLowerCase();
  // Tolerate a stale same-prefix file from an earlier engagement by
  // requiring the file to be newer than shortly before the room opened.
  const createdMs = createdIso ? new Date(createdIso).getTime() - 10 * 60 * 1000 : 0;
  let best = null;
  for (const name of entries) {
    const m = name.match(PLAN_FILE_RE);
    if (!m || !slug.startsWith(m[1])) continue;
    try {
      const mtime = statSync(resolve(PLANS_DIR, name)).mtimeMs;
      if (mtime < createdMs) continue;
      if (!best || mtime > best.mtime) best = { name, mtime };
    } catch {}
  }
  return best;
}

function gateForSession(tmuxSession) {
  let pane;
  try {
    // -e keeps SGR escapes: classifyPane needs them to tell a dim ghost
    // suggestion from typed text in the input box.
    pane = execFileSync("tmux", ["capture-pane", "-t", tmuxSession, "-p", "-e"],
                        { encoding: "utf8", timeout: 3000 });
  } catch {
    return { ok: false, reason: "session-gone" };
  }
  const plainLines = pane.replace(SGR_RE, "").split("\n");
  const working = detectWorking(plainLines);
  // The TUI footer says "⏸ plan mode on" while planning. In plan mode the
  // session cannot write plan.json, so runroom steps are frozen no matter how
  // much context arrives — the page should say so instead of looking stuck.
  const planMode = plainLines.slice(-6).some((l) => l.includes("plan mode on"));
  const verdict = classifyPane(pane);
  if (!verdict.ok) {
    if (verdict.reason === "dialog-open" && verdict.dialog) {
      verdict.dialog.context_full = fullDialogContext(tmuxSession);
    }
    return { ...verdict, working, planMode };
  }
  const holder = terminalHolderFor(tmuxSession);
  if (holder) return { ok: false, reason: "terminal-held", holder, working, planMode };
  return { ok: true, working, planMode };
}

const MAX_SEND_CHARS = 4000;

// Gate + type + submit + audit, shared by the free-text composer and the
// action buttons. Returns an {status, body} the caller forwards.
function deliver(session, plan, text, user, tag) {
  const gate = gateForSession(plan.tmux_session);
  if (!gate.ok) return { status: 409, body: { error: "gate closed", gate } };
  try {
    execFileSync("tmux", ["send-keys", "-t", plan.tmux_session, "-l", text], { timeout: 3000 });
    execFileSync("tmux", ["send-keys", "-t", plan.tmux_session, "Enter"], { timeout: 3000 });
  } catch (e) {
    return { status: 502, body: { error: `send failed: ${e.message}` } };
  }
  try {
    appendFileSync(resolve(RUNROOMS_DIR, session, "sends.log"),
      `${new Date().toISOString()} ${user?.login || "?"}${tag ? ` [${tag}]` : ""}: ${text.replace(/\n/g, "\\n")}\n`);
  } catch {}
  return { status: 200, body: { sent: true } };
}

// The operator's first name, for actor-labeled buttons and canned messages.
// No pronouns anywhere; loopback has no human name, so it gets "Human".
function firstNameOf(user) {
  if (!user || user.source === "loopback") return "Human";
  const name = (user.name || "").trim();
  if (name) return name.split(/\s+/)[0];
  return (user.login || "").split("@")[0] || "Human";
}

// The action protocol. Canned messages live HERE, not in the client, so the
// contract between button and session has exactly one author. Every message
// leads with [runroom] so the session knows the operator is speaking through
// the room, and every one restates the contract obligation it triggers —
// the UI's response to a click comes back through plan.json, not through an
// API side effect.
const ACTIONS = {
  opendia_do: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): do it yourself now, OpenDia. If the step's actor is "either", set it to "opendia" in plan.json first. Keep plan.json current as you work — file before prose.`,
  human_do: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): ${name} will do this by hand. Set the step's actor to "human" in plan.json and rewrite its detail as a walk-through — SHORT, the pane renders large type: a sentence or two per instruction, copyable commands in fenced code blocks, destructive ones behind a "> ⚠" line, never a secret — then wait for the runroom to report back.`,
  human_done: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): ${name} reports it finished. If a cheap check exists (file exists, DNS resolves, HTTP 200), run it before believing it. Then update plan.json: state "done" — or "failed" with the evidence in the step's note — advance current_step, and prepare the next step's detail.`,
  human_failed: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): ${name} reports it FAILED. Set state "failed" and record what is known in the step's note. Ask for or gather the error, then write next-move guidance into the step's detail — and if the plan needs restructuring, follow the contract's drift rule.`,
};

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
        plan_mtime: planMtime(session),
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
    const gate = plan.status === "active" ? gateForSession(plan.tmux_session) : { ok: false, reason: plan.status };
    // A plan-approval dialog gets the real plan document: the pane can only
    // ever show one page of it, the file holds all of it.
    if (gate.dialog?.options?.some((o) => /approve/i.test(o.label))) {
      const found = sessionPlanFile(plan.tmux_session, plan.created);
      if (found) {
        try {
          gate.dialog.plan_file = found.name;
          gate.dialog.plan_md = readFileSync(resolve(PLANS_DIR, found.name), "utf8").slice(0, 60_000);
        } catch {}
      }
    }
    res.json({
      ...plan,
      plan_mtime: planMtime(session),
      gate,
    });
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

    // Gate is re-checked inside deliver() at send time, not just at poll
    // time — the screen may have changed in the seconds since the composer
    // last looked. (-l literal, args array, no shell.)
    const { status, body } = deliver(session, plan, text, req.user, null);
    res.status(status).json(body);
  });

  app.post("/api/runrooms/:session/action", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });

    const { action, step } = req.body || {};
    const make = ACTIONS[action];
    if (!make) return res.status(400).json({ error: "unknown action" });
    // Buttons act on the CURRENT step only. A stale page (plan advanced since
    // its last poll) gets a conflict, not a mis-aimed instruction.
    if (Number(step) !== Number(plan.current_step)) {
      return res.status(409).json({ error: "stale step", current_step: plan.current_step });
    }
    const s = (plan.steps || []).find((x) => Number(x.n) === Number(step));
    if (!s) return res.status(400).json({ error: "no such step" });

    const text = make(s.n, s.title, firstNameOf(req.user));
    const { status, body } = deliver(session, plan, text, req.user, action);
    res.status(status).json(body);
  });

  // A pasted image. The session needs no special channel to receive one —
  // it needs a file path and a nudge to Read it (the Read tool renders
  // images). Raw body, not JSON: the global express.json 1MB limit would
  // choke screenshots, but it only parses application/json, so image/*
  // bypasses it entirely and lands in this route's own raw parser.
  const IMAGE_MAGIC = [
    { ext: "png",  test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { ext: "jpg",  test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: "gif",  test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
    { ext: "webp", test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                              && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  ];

  app.post("/api/runrooms/:session/image",
    express.raw({ type: "image/*", limit: "15mb" }),
    (req, res) => {
      const { session } = req.params;
      if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
      const plan = readPlan(session);
      if (!plan) return res.status(404).json({ error: "no such runroom" });
      if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });

      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length < 16) return res.status(400).json({ error: "no image body" });
      // Sniff the magic bytes; the client's Content-Type and any filename are
      // untrusted. The extension comes from what the bytes actually are.
      const kind = IMAGE_MAGIC.find((m) => m.test(buf));
      if (!kind) return res.status(400).json({ error: "not a recognized image (png/jpg/gif/webp)" });

      // Fail fast while the gate is closed — the attachment stays pending in
      // the client rather than orphaning a file here.
      const pre = gateForSession(plan.tmux_session);
      if (!pre.ok) return res.status(409).json({ error: "gate closed", gate: pre });

      let caption = typeof req.query.caption === "string" ? req.query.caption : "";
      caption = caption.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);

      const dir = resolve(RUNROOMS_DIR, session, "uploads");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const path = resolve(dir, `${stamp}.${kind.ext}`);
      try {
        writeFileSync(path, buf);
      } catch (e) {
        return res.status(500).json({ error: `save failed: ${e.message}` });
      }

      const name = firstNameOf(req.user);
      const text = `[runroom] ${name} pasted an image${caption ? ` — "${caption}"` : ""}: ${path} (open it with Read)`;
      const { status, body } = deliver(session, plan, text, req.user, "image");
      // deliver() re-gates; if the screen changed between the pre-check and
      // now, don't leave an orphan the session was never told about.
      if (status !== 200) { try { unlinkSync(path); } catch {} }
      res.status(status).json(status === 200 ? { sent: true, path } : body);
    });

  // Answer the dialog the session is currently showing. The one write that is
  // ALLOWED while the gate is closed — it exists precisely because the gate
  // is closed. Digits select immediately in the TUI's dialogs; Enter confirms
  // a multi-select; Escape cancels.
  app.post("/api/runrooms/:session/dialog", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });

    const { choice, fingerprint } = req.body || {};
    // Navigation keys exist for form-style dialogs: checkbox multiselects
    // toggle with Enter and move with arrows (number keys are inert there),
    // and the multi-question variant walks its parts with ←/→ ending on
    // Submit — the room must be able to drive all of it.
    if (!/^([1-9]|enter|esc|up|down|left|right|space)$/.test(String(choice))) {
      return res.status(400).json({ error: "bad choice" });
    }
    const isNav = !/^[1-9]$/.test(String(choice));

    // Re-read the screen at answer time. The dialog must still be up, must
    // still parse, and must be the SAME dialog the operator saw — a changed
    // fingerprint means their click was aimed at something that is gone.
    // Navigation keys are exempt from the fingerprint match: in a checkbox
    // form every toggle rewrites the labels ("[ ]"→"[✔]") and thus the
    // fingerprint, which turned the operator's second click into a stale
    // rejection loop. Arrows/space/enter/esc are safe against any dialog.
    const gate = gateForSession(plan.tmux_session);
    if (gate.reason !== "dialog-open" || !gate.dialog) {
      return res.status(409).json({ error: "no dialog on screen", gate });
    }
    if (!isNav && (!fingerprint || fingerprint !== gate.dialog.fingerprint)) {
      return res.status(409).json({ error: "dialog changed", gate });
    }
    if (/^[1-9]$/.test(String(choice)) &&
        !gate.dialog.options.some((o) => o.n === Number(choice))) {
      return res.status(400).json({ error: "no such option", gate });
    }

    const KEYMAP = { esc: "Escape", enter: "Enter", up: "Up", down: "Down", left: "Left", right: "Right", space: "Space" };
    const key = KEYMAP[choice] || String(choice);
    try {
      execFileSync("tmux", ["send-keys", "-t", plan.tmux_session, key], { timeout: 3000 });
    } catch (e) {
      return res.status(502).json({ error: `send failed: ${e.message}` });
    }
    try {
      const label = choice === "esc" || choice === "enter" ? choice
        : gate.dialog.options.find((o) => o.n === Number(choice))?.label;
      appendFileSync(resolve(RUNROOMS_DIR, session, "sends.log"),
        `${new Date().toISOString()} ${req.user?.login || "?"} [dialog]: ${choice} (${label})\n`);
    } catch {}
    res.json({ answered: true });
  });
}
