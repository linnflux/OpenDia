import { appendFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { terminalHolderFor } from "./terminal.js";

// session_gate.js — "is it safe to type into this tmux session right now?",
// and the low-level tmux-send/sends.log delivery built on top of the answer.
//
// Extracted verbatim from runrooms.js (zero behavior change) so a second
// caller (mailroom.js) can bind to a different standing session over the
// same modal-gate machinery. What stays runrooms-specific (RUNROOMS_DIR,
// SESSION_RE, plan.json reading, the ACTIONS canned-message registry, the
// routes themselves) stays in runrooms.js.

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

// When a dialog is up, pull it apart so the page can render it as buttons.
// Anchored on the option-cursor line ("❯ N.") — the one marker that only
// dialogs produce — then expanded over the contiguous numbered-option block
// around it. Context is what sits above the options up to the nearest rule:
// the question, the command being approved, the trust text. The fingerprint
// hashes what was parsed, so an answer can be refused if the dialog changed
// between the page's poll and the click — the dialog-race twin of the action
// endpoint's stale-step guard.
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
// show a long plan (the scrollback fallback above genuinely cannot contain
// it — there is nothing more to capture). The plan itself is a FILE, and a
// dispatched session's plan file is named from its first prompt — "Read
// ~/OpenDia/handoffs/<session>.md and follow it…" slugs to read-…-handoffs-
// <truncated-session>-<word>-<word>.md. Strip prefix and the two-word random
// suffix; what remains is a (possibly mid-word truncated) prefix of the
// session name. Generic to any spawned session, not runroom-specific —
// mailroom.js's standing session uses this too.
export const PLANS_DIR = resolve(process.env.HOME, ".claude", "plans");
const PLAN_FILE_RE = /^read-.*-handoffs-(.+)-[a-z]+-[a-z]+\.md$/;

export function sessionPlanFile(session, createdIso) {
  let entries;
  try {
    entries = readdirSync(PLANS_DIR);
  } catch {
    return null;
  }
  const slug = String(session).toLowerCase();
  // Tolerate a stale same-prefix file from an earlier engagement by
  // requiring the file to be newer than shortly before the room/session
  // opened. Prefixes truncate short ("mail" for both "mailroom-ui" and
  // "mailroom"), so this floor is what keeps an unrelated same-prefix
  // session's plan from being served as if it were this one's.
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

export function gateForSession(tmuxSession) {
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

// ── Live output ────────────────────────────────────────────────────────────
// While the session is mid-turn, the room shows a small ticker of what the
// pane is printing — the tail of the screen plus a little scrollback,
// primary text only. It is a monitor, not a transcript: no anchors, no
// per-room state, and it disappears the moment the turn ends and the room's
// real content (dialog, steps, announcement) takes over. Tracking "output
// since the click" precisely was tried first and lost to the TUI's
// full-screen redraws — the tail is what an operator glancing at a terminal
// actually sees anyway.
const LIVE_SCROLLBACK = 100;  // history lines a capture reaches back
const MAX_LIVE_LINES = 120;   // lines the payload may carry after filtering

// The pane tail, cleaned for reading: dim spans deleted (all-dim lines
// vanish — spinner meta, ghost suggestions, secondary chrome), SGR stripped,
// the bottom input-box/status chrome cut, blank runs collapsed. Returns null
// when there is nothing worth showing.
export function captureLiveTail(tmuxSession) {
  let pane;
  try {
    pane = execFileSync("tmux",
      ["capture-pane", "-t", tmuxSession, "-p", "-e", "-S", String(-LIVE_SCROLLBACK)],
      { encoding: "utf8", timeout: 3000 });
  } catch {
    return null;
  }
  const raw = pane.split("\n");
  let lines = [];
  for (const escLine of raw) {
    const undimmed = escLine.replace(DIM_SPAN_RE, "");
    const plain = undimmed.replace(SGR_RE, "").replace(/\s+$/, "");
    // A line that only had dim content is chrome, not a paragraph break —
    // drop it entirely rather than leaving a phantom blank.
    if (plain.trim() === "" && escLine.replace(SGR_RE, "").trim() !== "") continue;
    lines.push(plain);
  }
  // Cut the bottom chrome: the input box is the "❯" line sandwiched between
  // rules (same structural fact the gate relies on); everything from its top
  // rule down is TUI furniture, not output.
  const nonBlankIdx = (i, dir) => {
    for (let j = i + dir; j >= 0 && j < lines.length; j += dir) {
      if (lines[j].trim() !== "") return j;
    }
    return -1;
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("❯")) continue;
    const above = nonBlankIdx(i, -1), below = nonBlankIdx(i, +1);
    if (above >= 0 && RULE_RE.test(lines[above]) &&
        below >= 0 && RULE_RE.test(lines[below])) {
      lines = lines.slice(0, above);
      break;
    }
  }
  // The spinner/status line rides just above the input box.
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (last.trim() === "" || SPINNER_RE.test(last) ||
        last.includes("esc to interrupt") || last.includes("? for shortcuts")) {
      lines.pop();
    } else break;
  }
  while (lines.length && lines[0].trim() === "") lines.shift();
  const out = [];
  let blanks = 0;
  for (const l of lines) {
    // Bare rule/box-border lines are TUI furniture — in a four-row ticker a
    // horizontal line IS the whole view. (Dropped here, AFTER the chrome cut
    // above, which needs the rules intact to find the input box.)
    if (l.trim() !== "" && l.replace(/[─═╌┄╭╮╰╯│┌┐└┘├┤\s]/g, "") === "") continue;
    if (l.trim() === "") { if (++blanks > 1) continue; } else blanks = 0;
    out.push(l);
  }
  if (!out.length) return null;
  return { lines: out.slice(-MAX_LIVE_LINES) };
}

export const MAX_SEND_CHARS = 4000;

// Gate + type + submit + audit, shared by every free-text composer and
// action-button caller across runrooms and mailroom. Returns an
// {status, body} the caller forwards as the HTTP response.
//
// tmuxSession and logPath are separate on purpose: a runroom's log lives at
// RUNROOMS_DIR/<session>/sends.log (keyed by the plan's directory, which can
// in principle differ from the live tmux target after a relocatePlan), while
// the mailroom logs to one fixed ~/OpenDia/mailroom/sends.log regardless of
// which thread is selected.
export function deliver({ tmuxSession, logPath, text, user, tag }) {
  const gate = gateForSession(tmuxSession);
  if (!gate.ok) return { status: 409, body: { error: "gate closed", gate } };
  try {
    execFileSync("tmux", ["send-keys", "-t", tmuxSession, "-l", text], { timeout: 3000 });
    execFileSync("tmux", ["send-keys", "-t", tmuxSession, "Enter"], { timeout: 3000 });
  } catch (e) {
    return { status: 502, body: { error: `send failed: ${e.message}` } };
  }
  try {
    appendFileSync(logPath,
      `${new Date().toISOString()} ${user?.login || "?"}${tag ? ` [${tag}]` : ""}: ${text.replace(/\n/g, "\\n")}\n`);
  } catch {}
  return { status: 200, body: { sent: true } };
}

// The operator's first name, for actor-labeled buttons and canned messages.
// No pronouns anywhere; loopback has no human name, so it gets "Human".
export function firstNameOf(user) {
  if (!user || user.source === "loopback") return "Human";
  const name = (user.name || "").trim();
  if (name) return name.split(/\s+/)[0];
  return (user.login || "").split("@")[0] || "Human";
}
