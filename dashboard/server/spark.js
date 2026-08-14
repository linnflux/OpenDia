// spark.js — the Spark tab's server side.
//
// A Spark run is a headless Claude session scoped to one card. It sweeps every
// message front (email, Google Voice relays, Google Chat, Notion, timers,
// artifacts), then reports a single next step with a self-rated certitude
// number and up to three actions worth doing next.
//
// Three shape decisions worth knowing before reading:
//
//   * SSE, not a WebSocket. terminal.js's upgrade handler destroys every socket
//     whose URL isn't the terminal route, so a second WebSocketServer would be
//     dead on arrival. SSE is an ordinary Express route, which also means the
//     app-level requireLinnfluxUser applies without re-implementing authz.
//
//   * The server pre-fetches Notion, email, timers and inbox items into a brief
//     before the model starts. Two seconds of Node instead of ninety seconds of
//     agent turns, and the MCP servers stay off the critical path.
//
//   * A connecting client always receives a full `snapshot` frame first, so the
//     run state is authoritative on the server and there is no event log to
//     replay. Tab switches, modal closes and page reloads all reconnect to the
//     same truth.

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, createWriteStream,
  readdirSync, statSync, unlinkSync
} from "fs";
import { resolve } from "path";

import { getProjectById, getInboxItemsByProject, getProcessedGmailIds, updateProject } from "./db.js";
import { getTimerEntriesForProject } from "./timers.js";
import { fetchNotionPage, searchNotionForProject, appendTimerLog } from "./notion.js";
import { searchRecentEmails } from "./gmail.js";
import { requireAdmin } from "./auth.js";
import {
  etNow, durationStr, minutesBetween, listRunningTimers,
  findTimerForSession, startTimerForProject, closeTimerEntry, setEntryEstimate
} from "./timerfile.js";

const HOME = process.env.HOME || "/home/linnflux";
const CLAUDE_BIN = resolve(HOME, ".local", "bin", "claude");
const SPARK_ROOT = `${HOME}/OpenDia/spark`;

const MODEL = process.env.SPARK_MODEL || "opus";
const BUDGET_USD = process.env.SPARK_BUDGET_USD || "3.00";
const MAX_CONCURRENT = Number(process.env.SPARK_MAX_CONCURRENT || 2);
const HARD_KILL_MS = 20 * 60 * 1000;
const OVERRUN_MS = 15 * 60 * 1000;   // soft "past the estimate" signal
const RETAIN_MS = 10 * 60 * 1000;    // keep a finished run around for reconnects
const KEEPALIVE_MS = 20_000;
const BASE_ESTIMATE_MIN = 15;
const LOG_NOTION = process.env.SPARK_LOG_NOTION !== "false";

const MAX_ROUNDS = 4;
const MAX_ACTIONS_TOTAL = 8;
const ACCRUAL_PAUSE_MIN = 60;        // stop auto-accruing; ask the human first
const IDLE_WARN_MS = 20 * 60 * 1000; // waiting on a decision
const IDLE_WRAP_MS = 30 * 60 * 1000;

const FRONTS = ["timers", "notion", "email", "voice", "chat", "artifacts"];
const FRONT_STATES = ["pending", "checking", "done", "checked", "skipped", "unavailable"];

// Tools removed from the session outright. --disallowedTools is real
// enforcement (it holds even under bypassPermissions, unlike --allowedTools,
// which is merely additive to settings.json). Agent and Workflow are on the
// list because a subagent is otherwise a way to recover a blocked tool.
const DENY_SCAN = [
  "Edit", "NotebookEdit", "Agent", "Workflow",
  "mcp__google-workspace__gmail_send",
  "mcp__google-workspace__gmail_create_draft",
  "mcp__google-workspace__calendar_create_event",
  "mcp__google-workspace__calendar_update_event",
  "mcp__google-workspace__calendar_delete_event",
  "mcp__notion__notion_update_page",
  "mcp__notion__notion_create_page",
  "mcp__notion__notion_append_blocks",
  "mcp__notion__notion_update_block",
  "mcp__notion__notion_delete_block",
  "mcp__notion__notion_create_comment",
];

// The act phase may write to Notion and create drafts — it may never send.
const DENY_ACT = [
  "Agent", "Workflow",
  "mcp__google-workspace__gmail_send",
  "mcp__google-workspace__calendar_create_event",
  "mcp__google-workspace__calendar_update_event",
  "mcp__google-workspace__calendar_delete_event",
];

// Map<String(projectId), Run>
const runs = new Map();

// ── small helpers ──────────────────────────────────────────────────────────

/** Markdown survives; HTML does not. Spark's text is derived from client mail
 *  and chat, and the client renders body_md through marked into innerHTML. */
function escapeAngles(value) {
  if (typeof value === "string") return value.replace(/</g, "&lt;");
  if (Array.isArray(value)) return value.map(escapeAngles);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeAngles(v)]));
  }
  return value;
}

function freshFronts() {
  return Object.fromEntries(FRONTS.map((f) => [f, { state: "pending", detail: null }]));
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    elapsedSec: Math.round(((run.finishedAt || Date.now()) - run.startedAt) / 1000),
    fronts: run.fronts,
    verb: run.verb,
    ledger: run.ledger,
    round: run.round,
    roundsUsed: run.roundsUsed,
    roundsMax: MAX_ROUNDS,
    actions: run.actions,
    actionStates: run.actionStates,
    handoffs: run.handoffs || [],
    drafts: run.drafts,
    completed: run.completed,
    ballMoved: run.ballMoved,
    accruedMinutes: run.accruedMinutes,
    accrualPaused: run.accrualPaused,
    idleWrapAt: run.idleWrapAt || null,
    timerStarted: !!run.timer,
    timerNote: run.timerNote,
    costUsd: run.costUsd,
    model: MODEL,
    result: run.result,
    error: run.error,
  };
}

function emit(run, event, data) {
  run.seq += 1;
  const frame = `id: ${run.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of run.subs) {
    try { res.write(frame); } catch {}
  }
}

function pushLedger(run, kind, text) {
  const entry = { kind, text, at: new Date().toISOString() };
  run.ledger.push(entry);
  emit(run, "ledger", entry);
}

// ── run history on disk ────────────────────────────────────────────────────

/** Every run ever done on a card, newest first. Results are never pruned. */
function runsOnDisk(projectId) {
  const dir = `${SPARK_ROOT}/${projectId}`;
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    // A completed run has result.json; one that died mid-sweep has
    // interrupted.json instead. Both belong in history — a run that vanished
    // without trace is exactly what made a killed run look like a hang.
    const done = `${dir}/${name}/result.json`;
    const dead = `${dir}/${name}/interrupted.json`;
    const file = existsSync(done) ? done : existsSync(dead) ? dead : null;
    if (!file) continue;
    try {
      out.push({
        runId: name,
        at: new Date(statSync(file).mtimeMs).toISOString(),
        file,
        status: file === done ? "done" : "interrupted",
      });
    } catch {}
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * How far a run got, read back from its raw stream log.
 *
 * A run killed mid-sweep has no in-memory state left to ask, but every front
 * it finished printed a marker that is still sitting in raw.log.
 */
function frontsFromLog(runDir) {
  const out = {};
  let raw = "";
  try { raw = readFileSync(`${runDir}/raw.log`, "utf8"); } catch { return out; }
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(raw)) !== null) {
    if (!FRONTS.includes(m[1])) continue;
    const state = m[2] === "checked" ? "done" : m[2];
    if (FRONT_STATES.includes(state)) out[m[1]] = { state, detail: m[3] || null };
  }
  return out;
}

/**
 * Leave a record of a run that produced no recommendation.
 *
 * Without this a killed run is invisible in the tab — history lists results,
 * and there is no result — so the run looks like it never happened even though
 * its brief, log and ledger entry are all on disk.
 */
function writeInterrupted(runDir, reason) {
  try {
    const fronts = frontsFromLog(runDir);
    const reached = Object.entries(fronts)
      .filter(([, f]) => f.state === "done")
      .map(([name]) => name);
    writeFileSync(`${runDir}/interrupted.json`, JSON.stringify({
      schema: 1,
      status: "interrupted",
      at: new Date().toISOString(),
      reason,
      fronts,
      fronts_reached: reached,
    }, null, 2));
  } catch (err) {
    console.error("spark: could not record the interrupted run:", err.message);
  }
}

function readRunResult(entry) {
  try { return JSON.parse(readFileSync(entry.file, "utf8")); } catch { return null; }
}

function latestResultOnDisk(projectId) {
  const [newest] = runsOnDisk(projectId).filter((r) => r.status === "done");
  if (!newest) return null;
  const result = readRunResult(newest);
  return result ? { runId: newest.runId, at: newest.at, result } : null;
}

/**
 * Deal with Spark timers left behind when the dashboard stopped.
 *
 * A Spark state file carries a blank tmux_session on purpose, so nothing in a
 * terminal can find it — `/od-stop` looks up timers by session and will never
 * match one. That is the right trade (take-control can't mistake a Spark for a
 * work timer) but it means a restart would otherwise strand the entry in the
 * ledger with no way to close it from any surface. At boot there are no
 * in-memory runs, so every Spark timer on disk belongs to a dead process.
 *
 * A run that already produced its report is *recovered* rather than closed:
 * the report is on disk and the Claude session is resumable by id, so the
 * pending proposals survive the restart and can still be approved. Only a run
 * that died mid-sweep, with nothing to show, gets closed out.
 */
/**
 * Any run directory with a brief but no outcome belongs to a dead process.
 *
 * This is deliberately NOT driven by timer files: a run that started while the
 * card already had a timer never opens one of its own (it accrues to the
 * existing entry), so a timer-driven sweep would leave exactly those runs
 * invisible — the bug this whole record exists to prevent. Idempotent.
 */
function recordAbandonedRuns() {
  if (!existsSync(SPARK_ROOT)) return;
  for (const projectDir of readdirSync(SPARK_ROOT)) {
    const base = `${SPARK_ROOT}/${projectDir}`;
    let runIds = [];
    try { runIds = readdirSync(base); } catch { continue; }
    for (const runId of runIds) {
      const dir = `${base}/${runId}`;
      if (!existsSync(`${dir}/brief.json`)) continue;
      if (existsSync(`${dir}/result.json`) || existsSync(`${dir}/interrupted.json`)) continue;
      writeInterrupted(dir, "The dashboard stopped before the sweep finished.");
      console.log(`spark: recorded abandoned run ${runId} (card ${projectDir})`);
    }
  }
}

function recoverOrphanRuns() {
  for (const { file, data } of listRunningTimers()) {
    if (data.source !== "spark") continue;
    const runId = data.spark_run_id;
    const projectId = data.project_id;
    const runDir = runId && projectId ? `${SPARK_ROOT}/${projectId}/${runId}` : null;
    const project = projectId ? getProjectById(projectId) : null;
    const result = runDir && existsSync(`${runDir}/result.json`)
      ? readResultFile({ runDir }, "result.json")
      : null;

    if (project && result && !result.__parseError) {
      const run = newRun(project, runId, runDir, data.started_by || "");
      run.result = escapeAngles(result);
      run.timer = { stateFile: file, marker: data.marker, dailyFile: data.file, task: data.task };
      run.timerChecked = true;
      run.accruedMinutes = data.estimated_minutes || BASE_ESTIMATE_MIN;
      for (const f of result.fronts || []) {
        if (FRONTS.includes(f.front)) {
          const state = f.state === "checked" ? "done" : f.state;
          run.fronts[f.front] = { state: FRONT_STATES.includes(state) ? state : "done", detail: f.reason || null };
        }
      }
      runs.set(String(projectId), run);
      pushLedger(run, "warn", "The dashboard restarted; this run was recovered from disk.");
      offerActions(run, result.actions || []);
      console.log(`spark: recovered run ${runId} for card ${projectId}`);
      continue;
    }

    const endIso = etNow().iso;
    const actual = minutesBetween(data.marker, endIso);
    if (runDir) writeInterrupted(runDir, "The dashboard stopped before the sweep finished.");
    try {
      closeTimerEntry(
        data.file, data.marker, endIso,
        "Spark run interrupted — the dashboard stopped before the sweep finished. " +
        `Closed automatically after ${actual}m; no recommendation was produced, ` +
        "so nothing is billed for it.",
        0,
      );
      unlinkSync(file);
      console.log(`spark: closed orphaned timer ${data.marker} (card ${projectId})`);
    } catch (err) {
      console.error("spark: could not close orphaned timer:", err.message);
    }
  }
}

// ── the brief ──────────────────────────────────────────────────────────────

async function buildBrief(project, runId, runDir) {
  let linkedNotion = false;
  if (!project.notion_id) {
    try {
      const discovered = await searchNotionForProject(project.name, project.company_name);
      if (discovered) {
        updateProject(project.id, { notion_id: discovered });
        project.notion_id = discovered;
        linkedNotion = true;
      }
    } catch (err) {
      console.error("spark: notion discovery failed:", err.message);
    }
  }

  let notion = null;
  if (project.notion_id) {
    try { notion = await fetchNotionPage(project.notion_id); }
    catch (err) { console.error("spark: notion fetch failed:", err.message); }
  }

  let timers = [];
  try { timers = await getTimerEntriesForProject(project, 5); }
  catch (err) { console.error("spark: timer lookup failed:", err.message); }

  // Same adaptive lookback the review route uses: cover everything since the
  // last work session plus a week, clamped to 7-60 days.
  let lookbackDays = 30;
  if (timers[0]?.start) {
    const daysSinceWork = Math.ceil((Date.now() - new Date(timers[0].start).getTime()) / 86400000);
    lookbackDays = Math.min(Math.max(daysSinceWork + 7, 7), 60);
  }

  let emails = [];
  try {
    emails = await searchRecentEmails(project.company_name, {
      shortName: project.company_short,
      days: lookbackDays,
    });
  } catch (err) {
    console.error("spark: gmail search failed:", err.message);
  }
  let processed = new Set();
  try { processed = getProcessedGmailIds(); } catch {}

  let inboxItems = [];
  try { inboxItems = getInboxItemsByProject(project.id); } catch {}

  const running = listRunningTimers()
    .map((t) => t.data)
    .filter((d) => d.project_id === project.id || (project.tmux_session && d.tmux_session === project.tmux_session));

  return {
    schema: 1,
    run_id: runId,
    run_dir: runDir,
    out_path: `${runDir}/result.json`,
    today: etNow().iso.slice(0, 10),
    estimated_minutes: BASE_ESTIMATE_MIN,
    project: {
      id: project.id,
      name: project.name,
      company_name: project.company_name,
      company_short: project.company_short,
      division: project.division,          // NOT division_name — the join names it `division`
      status: project.status,
      notes: project.notes,
      tags: project.tags,
      next_step: project.next_step,
      notion_id: project.notion_id,
      tmux_session: project.tmux_session,
    },
    notion,
    notion_linked_by_this_run: linkedNotion,
    timers,
    email_lookback_days: lookbackDays,
    emails: emails.map((e) => ({ ...e, already_ingested: processed.has(e.id) })),
    inbox_items: inboxItems,
    active_timers: running,
  };
}

// ── timer lifecycle ────────────────────────────────────────────────────────

function startSparkTimer(run, project) {
  if (run.timer || run.timerChecked) return;
  run.timerChecked = true;

  // Never open a second timer on a card that already has one running: accrue
  // to the existing entry instead. Two overlapping timers on one client is the
  // mess /timer-merge exists to clean up.
  const existing = listRunningTimers().find(
    (t) => t.data.project_id === project.id ||
           (project.tmux_session && t.data.tmux_session === project.tmux_session)
  );
  if (existing) {
    run.timerNote = "existing_timer";
    emit(run, "timer", { started: false, reason: "existing_timer", task: existing.data.task });
    pushLedger(run, "timer", `Existing timer running — this Spark accrues to it, not a new entry.`);
    return;
  }

  try {
    // tmux_session is deliberately blank: findTimerForSession matches on it, so
    // a named session here would make take-control skip starting its own timer
    // and let real work bill against this entry.
    const info = startTimerForProject(project, `${project.name} — Spark next-step refresh`, {
      estimatedMinutes: BASE_ESTIMATE_MIN,
      tmuxSession: "",
      extra: { source: "spark", spark_run_id: run.id, started_by: run.startedBy || "" },
    });
    run.timer = info;
    run.accruedMinutes = BASE_ESTIMATE_MIN;
    emit(run, "timer", { started: true, estimated_minutes: BASE_ESTIMATE_MIN, marker: info.marker, accrued: run.accruedMinutes });
    pushLedger(run, "timer", `Timer opened at a ${BASE_ESTIMATE_MIN}-minute estimate.`);
  } catch (err) {
    console.error("spark: timer start failed:", err.message);
  }
}

async function closeSparkTimer(run, project, { failed = false, reason = "" } = {}) {
  if (!run.timer || run.timerClosed) return;
  run.timerClosed = true;

  const endIso = etNow().iso;
  const actual = minutesBetween(run.timer.marker, endIso);

  let notes;
  let estimate = run.accruedMinutes || BASE_ESTIMATE_MIN;

  if (failed) {
    // A run that produced no recommendation delivered nothing, so it bills
    // nothing. The entry stays as a record of what happened — this used to
    // bill a five-minute minimum, which then had to be hand-zeroed every time.
    estimate = 0;
    notes = `Spark run ${reason || "did not complete"} after ${actual}m — `
          + "no recommendation produced, so nothing is billed for it.";
  } else {
    const bullets = Array.isArray(run.result?.timer_notes)
      ? run.result.timer_notes.filter((b) => typeof b === "string" && b.trim())
      : [];
    if (bullets.length >= 2) {
      // Every executed action adds its own bullet, so the notes justify the
      // accrued estimate rather than only the 15-minute sweep. The NEXT line
      // stays last.
      const actionBullets = run.completed
        .map((c) => c.note_bullet || c.summary)
        .filter(Boolean);
      const nextIdx = bullets.findIndex((b) => b.trim().startsWith("NEXT:"));
      const body = nextIdx === -1 ? bullets : bullets.slice(0, nextIdx);
      const tail = nextIdx === -1 ? [] : bullets.slice(nextIdx);
      notes = [...body, ...actionBullets, ...tail].join("\n");
    } else {
      // Floor: never write a note-less entry. Synthesise from what was checked.
      const checked = Object.entries(run.fronts)
        .filter(([, f]) => f.state === "done" || f.state === "checked")
        .map(([name, f]) => `Checked ${name}${f.detail ? ` — ${f.detail}` : ""}`);
      notes = [
        `Spark context refresh across ${checked.length} message front(s) for ${project.name}.`,
        ...checked,
        run.result?.next_step?.text ? `NEXT: ${run.result.next_step.text}` : "",
      ].filter(Boolean).join("\n");
    }
  }

  try {
    closeTimerEntry(run.timer.dailyFile, run.timer.marker, endIso, notes, estimate);
  } catch (err) {
    console.error("spark: closeTimerEntry failed:", err.message);
  }
  try { unlinkSync(run.timer.stateFile); } catch {}

  if (LOG_NOTION && project.notion_id && !failed) {
    try {
      await appendTimerLog(project.notion_id, {
        start: run.timer.marker,
        task: run.timer.task,
        duration: durationStr(run.timer.marker, endIso),
        notes,
      });
    } catch (err) {
      console.error("spark: notion timer log failed:", err.message);
    }
  }

  pushLedger(run, "timer", `Timer closed — ${estimate}m billed.`);
}

// ── stream-json parsing ────────────────────────────────────────────────────

// Markers are read out of the tool_use input, which arrives JSON-stringified —
// so the quotes around detail/reason come through escaped as \" and the
// backslash has to be optional on both sides.
const MARKER_RE = /@@SPARK\s+front=(\w+)\s+state=(\w+)(?:\s+(?:detail|reason)=\\?"([^"\\]*)\\?")?/g;
const ACTION_RE = /@@SPARK\s+action=([\w-]+)\s+state=(\w+)(?:\s+(?:detail|reason)=\\?"([^"\\]*)\\?")?/g;

const FRONT_VERB = {
  timers: "Reviewing recent work sessions",
  notion: "Reading the Notion task",
  email: "Scanning email",
  voice: "Checking Google Voice relays",
  chat: "Reading Google Chat",
  artifacts: "Checking what actually moved on disk",
};

const VERB_FOR_TOOL = [
  [/oracle_gmail\.py|gmail_search|gmail_list/i, "Scanning email"],
  [/txt\.voice\.google\.com/i, "Checking Google Voice relays"],
  [/chat_helper\.py|mcp__google-workspace__chat_/i, "Reading Google Chat"],
  [/mcp__notion__/i, "Reading the Notion task"],
  [/OpenDia\/Time/i, "Reviewing recent work sessions"],
];

function applyMarker(run, front, state, detail) {
  if (!FRONTS.includes(front) || !FRONT_STATES.includes(state)) return;
  const normalised = state === "checked" ? "done" : state;
  // A `done` marker carries the detail; a later marker without one must not
  // wipe the line a human is reading.
  const keep = detail || (normalised === "checking" ? null : run.fronts[front]?.detail || null);
  run.fronts[front] = { state: normalised, detail: keep };
  emit(run, "phase", { front, state: normalised, detail: keep });
  if (normalised === "checking" && FRONT_VERB[front]) setVerb(run, FRONT_VERB[front]);
  if (normalised === "done") startSparkTimer(run, run.project);
}

function applyActionMarker(run, id, state, detail) {
  if (!run.actionStates[id]) return;
  const allowed = ["running", "done", "failed", "blocked"];
  if (!allowed.includes(state)) return;
  run.actionStates[id] = { state, detail: detail || run.actionStates[id].detail || null };
  emit(run, "action_progress", { id, state, detail: detail || null });
  if (state === "running") {
    const label = run.actions.find((x) => x.id === id)?.label;
    if (label) setVerb(run, `Working on: ${label}`);
  }
}

function setVerb(run, verb) {
  // null deliberately clears the line — the pane is no longer thinking.
  if (run.verb === verb) return;
  run.verb = verb;
  emit(run, "thinking", { verb });
}

function handleStreamLine(run, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type !== "tool_use") continue;
      const payload = JSON.stringify(block.input || {});

      // Explicit markers are the primary signal — visible the moment the
      // model emits the call, without waiting for the tool result.
      MARKER_RE.lastIndex = 0;
      let m, sawMarker = false;
      while ((m = MARKER_RE.exec(payload)) !== null) {
        sawMarker = true;
        applyMarker(run, m[1], m[2], m[3] ? m[3].replace(/\\n/g, " ").trim() : "");
      }
      ACTION_RE.lastIndex = 0;
      let a;
      while ((a = ACTION_RE.exec(payload)) !== null) {
        sawMarker = true;
        applyActionMarker(run, a[1], a[2], a[3] ? a[3].replace(/\\n/g, " ").trim() : "");
      }
      if (sawMarker) continue;

      // Fallback so the pane never sits dead if a marker is skipped. Only in
      // the scan phase — during a round the verb names the action being run,
      // and a front verb there would be a lie.
      if (run.phase !== "scan") continue;
      const probe = `${block.name || ""} ${payload}`;
      const hit = VERB_FOR_TOOL.find(([re]) => re.test(probe));
      if (hit) setVerb(run, hit[1]);
      else if (block.name === "Write") setVerb(run, "Writing up the recommendation");
    }
  }

  if (msg.type === "result") {
    if (typeof msg.total_cost_usd === "number") run.costUsd = msg.total_cost_usd;
    if (msg.usage && typeof msg.usage === "object") run.usage = msg.usage;
    run.finalText = typeof msg.result === "string" ? msg.result : "";
  }
}

// ── result validation ──────────────────────────────────────────────────────

function readResultFile(run, name = "result.json") {
  const file = `${run.runDir}/${name}`;
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch (err) {
      return { __parseError: err.message };
    }
  }
  // Fallback: the last fenced JSON block in the final assistant message.
  const fences = [...(run.finalText || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  if (fences.length) {
    try { return JSON.parse(fences[fences.length - 1][1]); } catch {}
  }
  return null;
}

const PRONOUNS = /\b(I|we|you|he|she|they|us|our|your|their|my|me|him|her|them)\b/i;

// Tiers are named rather than numbered. The model has to emit this field from a
// routine it read once, and "handoff" is self-describing where 3 was a mapping
// it had to recall — which is why the defaulting branch below exists at all.
// Names also survive adding a tier later; numbers would shift underneath us.
const TIER_PERFORMED = "performed";  // done on approval
const TIER_HANDOFF = "handoff";      // never done here; becomes a brief + session
const TIERS = [TIER_PERFORMED, TIER_HANDOFF];

// Legacy runs on disk carry integers, and a model that has cached the old
// routine may still emit one. 2 was the dashboard-sends-an-email tier and no
// longer exists, so it lands on handoff with everything else unrecognised.
const LEGACY_TIERS = { 1: TIER_PERFORMED, 2: TIER_HANDOFF, 3: TIER_HANDOFF };

/** Coerce any tier — named, legacy integer, or junk — to a known name.
 *  Unknown always resolves to handoff: guessing toward "performed" would be
 *  the dangerous direction, so the safe default is written into the fallback
 *  rather than left to depend on which value happens to sort last. */
function normaliseTier(tier) {
  if (TIERS.includes(tier)) return tier;
  return LEGACY_TIERS[tier] || TIER_HANDOFF;
}

function validateResult(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object") return { ok: false, problems: ["no result JSON was produced"] };
  if (raw.__parseError) return { ok: false, problems: [`result.json is not valid JSON: ${raw.__parseError}`] };
  if (raw.schema !== 1) problems.push(`unexpected schema ${JSON.stringify(raw.schema)}`);

  const pct = raw?.certitude?.pct;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) problems.push("certitude.pct must be an integer 0-100");
  if (!raw?.next_step?.text) problems.push("next_step.text is empty");
  if (!raw?.body_md) problems.push("body_md is empty");
  if (!Array.isArray(raw.fronts) || raw.fronts.length === 0) problems.push("fronts is empty");
  else {
    const unknown = raw.fronts.map((f) => f.front).filter((f) => !FRONTS.includes(f));
    if (unknown.length) problems.push(`unknown front(s): ${unknown.join(", ")}`);
  }
  if (raw.actions && !Array.isArray(raw.actions)) problems.push("actions must be an array");

  if (problems.length) return { ok: false, problems };

  // Soft lints — surfaced, never blocking. A good recommendation is not
  // withheld over grammar.
  const warnings = [];
  const prose = [raw.headline, raw.next_step?.text, raw.risk, raw.body_md]
    .filter((s) => typeof s === "string").join("\n");
  if (PRONOUNS.test(prose)) warnings.push("contains personal pronouns");
  if ((raw.certitude?.reason || "").length < 20) warnings.push("certitude reason is thin");
  if ((raw.proposed_next_step?.value || "").length > 100) warnings.push("proposed next step exceeds 100 chars");

  const actions = (raw.actions || []).slice(0, 3).map((a, i) => ({
    id: a.id || `a${i + 1}`,
    label: String(a.label || "Action").slice(0, 24),
    what: a.what || "",
    why: a.why || "",
    tier: normaliseTier(a.tier),
    estimated_minutes: Number.isFinite(a.estimated_minutes) ? Math.max(0, Math.round(a.estimated_minutes)) : 5,
    reversible: a.reversible !== false,
    preview: a.preview || null,
  }));

  return { ok: true, result: { ...raw, actions, style_warnings: warnings } };
}

function normaliseActions(list, offset = 0) {
  return (Array.isArray(list) ? list : []).slice(0, 3).map((a, i) => ({
    id: a.id || `x${offset + i + 1}`,
    label: String(a.label || "Action").slice(0, 24),
    what: a.what || "",
    why: a.why || "",
    tier: normaliseTier(a.tier),
    estimated_minutes: Number.isFinite(a.estimated_minutes) ? Math.max(0, Math.round(a.estimated_minutes)) : 5,
    reversible: a.reversible !== false,
    preview: a.preview || null,
  }));
}

function validateRound(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, problems: ["no round JSON was produced"] };
  if (raw.__parseError) return { ok: false, problems: [`round JSON is invalid: ${raw.__parseError}`] };
  if (!Array.isArray(raw.completed)) return { ok: false, problems: ["completed must be an array"] };

  return {
    ok: true,
    round: {
      ...raw,
      completed: raw.completed.map((c) => ({
        id: c.id,
        status: ["done", "failed", "blocked"].includes(c.status) ? c.status : "done",
        summary: c.summary || "",
        evidence: c.evidence || null,
        minutes: Number.isFinite(c.minutes) ? Math.max(0, Math.round(c.minutes)) : 5,
        note_bullet: c.note_bullet || c.summary || "",
      })),
      next_actions: normaliseActions(raw.next_actions),
    },
  };
}

// ── the run ────────────────────────────────────────────────────────────────

function finishRun(run, status) {
  run.status = status;
  run.finishedAt = Date.now();
  clearTimeout(run.killTimer);
  clearTimeout(run.overrunTimer);
  emit(run, "end", {
    status,
    elapsedSec: Math.round((run.finishedAt - run.startedAt) / 1000),
    costUsd: run.costUsd,
    accruedMinutes: run.accruedMinutes,
  });
  for (const res of run.subs) { try { res.end(); } catch {} }
  run.subs.clear();
  setTimeout(() => {
    if (runs.get(String(run.projectId)) === run) runs.delete(String(run.projectId));
  }, RETAIN_MS).unref?.();
}

function spawnPhase(run, { prompt, deny, resume }) {
  const args = [
    "-p", prompt,
    ...(resume ? ["--resume", run.id] : ["--session-id", run.id]),
    "--model", run.agent?.model || MODEL,
    "--permission-mode", "bypassPermissions",
    "--disallowedTools", deny.join(" "),
    "--output-format", "stream-json",
    "--verbose",
    "--max-budget-usd", String(run.agent?.budgetUsd || BUDGET_USD),
    "--add-dir", `${HOME}/OpenDia`,
  ];

  // Bash has no tool name to deny, so the shell surface is fenced by a
  // PreToolUse hook instead: no outbound mail, no remote systems, no git
  // writes, and no file writes outside this run's directory.
  const guardScript = `${HOME}/OpenDia/scripts/spark_guard.py`;
  if (existsSync(guardScript)) {
    const guardFile = `${run.runDir}/guard.json`;
    // An agent run may also write its own scratchpad memory.
    const allowDir = run.agent ? ` --allow-dir ${HOME}/OpenDia/agents/${run.agent.slug}` : "";
    writeFileSync(guardFile, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit",
          hooks: [{ type: "command", command: `python3 ${guardScript} --run-dir ${run.runDir}${allowDir}` }],
        }],
      },
    }, null, 2));
    args.push("--settings", guardFile);
  }

  const proc = spawn(CLAUDE_BIN, args, { cwd: `${HOME}/OpenDia`, stdio: ["ignore", "pipe", "pipe"] });
  run.proc = proc;
  run.finalText = "";

  const rawLog = createWriteStream(`${run.runDir}/raw.log`, { flags: "a" });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    rawLog.write(line + "\n");
    // A parse failure must never take the run down.
    try { handleStreamLine(run, line); }
    catch (err) { console.error("spark: stream line error:", err.message); }
  });
  proc.stderr.on("data", (d) => rawLog.write(d));

  clearTimeout(run.killTimer);
  run.killTimer = setTimeout(() => {
    pushLedger(run, "warn", "Hard limit reached at 20 minutes — the run was stopped.");
    stopProc(run);
  }, HARD_KILL_MS);

  return proc;
}

function rawTail(run, bytes = 2048) {
  try { return readFileSync(`${run.runDir}/raw.log`, "utf8").slice(-bytes); } catch { return ""; }
}

function newRun(project, runId, runDir, startedBy) {
  return {
    id: runId,
    projectId: project.id,
    project,
    status: "scanning",
    phase: "scan",
    round: 0,
    startedAt: Date.now(),
    finishedAt: null,
    seq: 0,
    subs: new Set(),
    fronts: freshFronts(),
    verb: "Reading the card",
    ledger: [],
    actions: [],
    actionStates: {},
    handoffs: [],
    drafts: [],
    completed: [],
    ballMoved: null,
    accruedMinutes: 0,
    accrualPaused: false,
    roundsUsed: 0,
    actionsRun: 0,
    timer: null,
    timerChecked: false,
    timerClosed: false,
    timerNote: null,
    costUsd: null,
    result: null,
    error: null,
    runDir,
    startedBy,
    finalText: "",
  };
}

export async function startScan(project, startedBy, opts = {}) {
  const runId = randomUUID();
  const runDir = `${SPARK_ROOT}/${project.id}/${runId}`;
  mkdirSync(runDir, { recursive: true });

  const run = newRun(project, runId, runDir, startedBy);
  // ODA context: {slug, name, model, budgetUsd}. Persisted on the run so act
  // rounds (spawnPhase resume) keep the agent's model/budget and guard jail.
  run.agent = opts.agent || null;
  runs.set(String(project.id), run);

  // The brief is built before the spawn so the first fronts light up fast.
  let brief;
  try {
    brief = await buildBrief(project, runId, runDir);
  } catch (err) {
    run.error = { message: `brief build failed: ${err.message}` };
    emit(run, "error", run.error);
    finishRun(run, "error");
    return run;
  }
  writeFileSync(`${runDir}/brief.json`, JSON.stringify(brief, null, 2));

  const agentPreamble = run.agent
    ? `You are ${run.agent.name}, an OpenDia Agent (ODA). Before the sweep, read ` +
      `${HOME}/OpenDia/agents/${run.agent.slug}/agent.md (your expertise and operating rules) and ` +
      `${HOME}/OpenDia/agents/${run.agent.slug}/memory.md (your scratchpad). Apply that expertise ` +
      `throughout. After writing the result JSON, append any durable learnings to memory.md as ` +
      `dated bullets, newest first — keep the file under 60 lines, pruning the oldest entries.\n\n`
    : "";

  const proc = spawnPhase(run, {
    prompt:
      agentPreamble +
      `Run /spark ${runDir}/brief.json\n\n` +
      "Invoked headlessly from the OpenDia dashboard Spark tab. There is no interactive user — " +
      "never ask a question and never wait for input. Write the result JSON to the out_path " +
      "named in the brief, then stop.",
    deny: DENY_SCAN,
    resume: false,
  });

  run.overrunTimer = setTimeout(() => {
    setVerb(run, "Taking longer than usual");
  }, OVERRUN_MS);

  proc.on("error", async (err) => {
    run.error = { message: `could not start claude: ${err.message}` };
    emit(run, "error", run.error);
    await closeSparkTimer(run, project, { failed: true, reason: "failed to start" });
    finishRun(run, "error");
  });

  proc.on("close", async () => {
    if (run.status === "cancelled" || run.status === "error") return;
    const verdict = validateResult(readResultFile(run, "result.json"));

    if (!verdict.ok) {
      writeInterrupted(runDir, `The run ended without a usable result (${verdict.problems[0]}).`);
      run.error = { message: verdict.problems.join("; "), raw_tail: rawTail(run) };
      emit(run, "error", run.error);
      await closeSparkTimer(run, project, {
        failed: true,
        reason: `produced no usable result (${verdict.problems[0]})`,
      });
      finishRun(run, "error");
      return;
    }

    run.result = escapeAngles(verdict.result);
    // Reconcile the checklist with what the report actually claims, so a
    // missed marker doesn't leave a front stuck on "pending".
    for (const f of run.result.fronts || []) {
      if (FRONTS.includes(f.front)) {
        const state = f.state === "checked" ? "done" : f.state;
        run.fronts[f.front] = {
          state: FRONT_STATES.includes(state) ? state : "done",
          detail: run.fronts[f.front]?.detail || f.reason || null,
        };
      }
    }
    startSparkTimer(run, project);
    emit(run, "result", run.result);
    offerActions(run, run.result.actions || []);
  });

  return run;
}

/**
 * Hand a set of proposals to the human and wait. The run stays open (and the
 * timer with it) until a decision arrives, the actions run out, or the idle
 * timeout wraps it up.
 */
function offerActions(run, actions) {
  // The phase is over: neither the hard-kill nor the overrun verb applies
  // while a human is deciding.
  clearTimeout(run.killTimer);
  clearTimeout(run.overrunTimer);

  const roomLeft = MAX_ACTIONS_TOTAL - run.actionsRun;
  // Normalise here rather than trusting the caller: the recovery path feeds
  // this straight from a result.json on disk, and an archived run carries
  // integer tiers that never went through a validator. Coercion is idempotent,
  // so the two already-validated callers are unaffected.
  const tiered = (actions || []).map((a) => ({ ...a, tier: normaliseTier(a.tier) }));
  const usable = tiered
    .filter((a) => a.tier === TIER_PERFORMED)   // a handoff is a brief, never a button
    .slice(0, Math.max(0, Math.min(3, roomLeft)));
  const handoffs = tiered.filter((a) => a.tier === TIER_HANDOFF);

  run.actions = usable;
  run.handoffs = handoffs;
  for (const a of usable) run.actionStates[a.id] = { state: "pending" };

  if (run.roundsUsed >= MAX_ROUNDS) {
    pushLedger(run, "warn", `Round limit reached (${MAX_ROUNDS}) — remaining work belongs in a session.`);
  }

  const canOffer = usable.length > 0 && run.roundsUsed < MAX_ROUNDS && !run.accrualPaused;
  if (!canOffer) {
    wrapUp(run);
    return;
  }

  run.status = "proposing";
  run.phase = "propose";
  setVerb(run, null);
  emit(run, "actions", { round: run.roundsUsed + 1, items: usable, handoffs });

  clearTimeout(run.idleWarnTimer);
  clearTimeout(run.idleWrapTimer);
  run.idleWarnTimer = setTimeout(() => {
    pushLedger(run, "warn", "Waiting on a decision — this Spark wraps up in 10 minutes.");
  }, IDLE_WARN_MS);
  run.idleWrapAt = Date.now() + IDLE_WRAP_MS;
  run.idleWrapTimer = setTimeout(() => {
    pushLedger(run, "warn", "No decision after 30 minutes — wrapping up so the timer does not sit open.");
    wrapUp(run);
  }, IDLE_WRAP_MS);
}

async function wrapUp(run) {
  clearTimeout(run.idleWarnTimer);
  clearTimeout(run.idleWrapTimer);
  clearTimeout(run.overrunTimer);
  run.status = "wrapping";
  await closeSparkTimer(run, run.project);
  finishRun(run, "done");
}

async function startRound(run, decisions, note = "") {
  const project = run.project;
  run.roundsUsed += 1;
  run.round = run.roundsUsed;
  run.status = "acting";
  run.phase = "act";
  clearTimeout(run.idleWarnTimer);
  clearTimeout(run.idleWrapTimer);

  const approved = run.actions.filter((a) => decisions[a.id] === "do");
  for (const a of run.actions) {
    const state = decisions[a.id] === "do" ? "running" : "skipped";
    run.actionStates[a.id] = { state, detail: null };
    emit(run, "action_progress", { id: a.id, state, detail: null });
    if (state === "skipped") pushLedger(run, "skip", `Skipped: ${a.label}`);
  }

  if (note) pushLedger(run, "note", `Clarification: ${note}`);

  const roundFile = `${run.runDir}/round-${run.round}.json`;
  const outPath = `${run.runDir}/round-${run.round}-result.json`;
  writeFileSync(roundFile, JSON.stringify({
    schema: 1,
    run_dir: run.runDir,
    out_path: outPath,
    round: run.round,
    decisions,
    operator_note: note || null,
    actions: run.actions,
    accrued_minutes: run.accruedMinutes,
    rounds_remaining: MAX_ROUNDS - run.roundsUsed,
    project: {
      id: project.id,
      name: project.name,
      company_name: project.company_name,
      division: project.division,
      notion_id: project.notion_id,
      next_step: project.next_step,
      status: project.status,
      tmux_session: project.tmux_session,
    },
    result: run.result,
  }, null, 2));

  setVerb(run, approved.length ? `Working on: ${approved[0].label}` : "Wrapping up");

  const proc = spawnPhase(run, {
    prompt:
      `Run /spark-act ${roundFile}\n\n` +
      // The note goes in the prompt as well as the round file. Buried in JSON
      // it reads as one more field; up here it reads as an instruction, which
      // is what it is. Same shape as the inbox dispatcher's operator
      // correction block.
      (note
        ? "## Operator Correction\n\nThe operator reviewed these proposals and "
          + "provided the following correction. It outranks the plan below — apply "
          + "it to every approved action, and say in each summary how it was "
          + `applied:\n\n${note}\n\n`
        : "") +
      "Invoked headlessly from the OpenDia dashboard Spark tab. There is no interactive user — " +
      "never ask a question and never wait for input. Carry out only the approved actions, " +
      "write the result JSON to the out_path named in the round file, then stop.",
    deny: DENY_ACT,
    resume: true,
  });

  proc.on("error", async (err) => {
    run.error = { message: `could not resume the Spark session: ${err.message}` };
    emit(run, "error", run.error);
    await wrapUp(run);
  });

  proc.on("close", async () => {
    if (run.status === "cancelled") return;
    const raw = readResultFile(run, `round-${run.round}-result.json`);
    const round = validateRound(raw);

    if (!round.ok) {
      run.error = { message: `round ${run.round}: ${round.problems.join("; ")}`, raw_tail: rawTail(run) };
      emit(run, "error", run.error);
      for (const a of approved) {
        run.actionStates[a.id] = { state: "failed", detail: "no result reported" };
        emit(run, "action_progress", { id: a.id, state: "failed", detail: "no result reported" });
      }
      await wrapUp(run);
      return;
    }

    const data = escapeAngles(round.round);
    applyRoundResult(run, data);
    offerActions(run, data.next_actions || []);
  });
}

function applyRoundResult(run, data) {
  for (const c of data.completed || []) {
    const state = ["done", "failed", "blocked"].includes(c.status) ? c.status : "done";
    run.actionStates[c.id] = { state, detail: c.summary || null };
    emit(run, "action_progress", { id: c.id, state, detail: c.summary || null });

    const label = run.actions.find((a) => a.id === c.id)?.label || c.id;
    pushLedger(run, state, `${state === "done" ? "" : `${state}: `}${c.summary || label}`);

    run.completed.push(c);
    run.actionsRun += 1;

    // Accrual: only completed work bills, and it stops climbing at the pause
    // threshold so a long chain becomes an explicit decision.
    if (state === "done" && run.timer && !run.accrualPaused) {
      const mins = Number.isFinite(c.minutes) ? Math.max(0, Math.round(c.minutes)) : 5;
      run.accruedMinutes = Math.min(ACCRUAL_PAUSE_MIN, run.accruedMinutes + mins);
      setEntryEstimate(run.timer.dailyFile, run.timer.marker, run.accruedMinutes);
      if (run.accruedMinutes >= ACCRUAL_PAUSE_MIN) {
        run.accrualPaused = true;
        pushLedger(run, "warn", `Accrual paused at ${ACCRUAL_PAUSE_MIN}m — further work needs a fresh timer.`);
      }
      emit(run, "timer", { started: true, accrued: run.accruedMinutes });
    }
  }

  for (const d of data.drafts || []) {
    if (!d?.to || !d?.body) continue;
    const draft = { id: d.id || `d${run.drafts.length + 1}`, to: d.to, subject: d.subject || "", body: d.body };
    run.drafts.push(draft);
    emit(run, "draft", draft);
  }

  if (data.ball_moved) {
    run.ballMoved = data.ball_moved;
    emit(run, "ball_moved", { text: data.ball_moved });
  }

  if (data.recommendation_update && run.result) {
    const u = data.recommendation_update;
    run.result = {
      ...run.result,
      headline: u.headline || run.result.headline,
      next_step: u.next_step || run.result.next_step,
      certitude: u.certitude || run.result.certitude,
    };
    emit(run, "result", run.result);
  }
}

function stopProc(run) {
  if (!run.proc || run.proc.killed) return;
  try { run.proc.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { run.proc.kill("SIGKILL"); } catch {} }, 5000).unref?.();
}

// Nothing here sends. Spark's outbound responsibility ends at a Gmail draft:
// the act phase creates one, the panel reads it back for review, and the human
// sends it from Gmail. There is deliberately no send path on the server — a
// dormant one behind requireAdmin is just a thing that gets re-wired later.

/** Write a session brief so a handoff lands with the Spark findings intact. */
function writeHandoff(project, run) {
  const dir = `${HOME}/OpenDia/handoffs`;
  mkdirSync(dir, { recursive: true });
  const slug = (project.tmux_session || `card-${project.id}`).replace(/[^\w.-]/g, "-");
  const file = `${dir}/${slug}.md`;
  const r = run.result || {};
  const lines = [
    `# ${project.name} — Spark handoff`,
    ``,
    `Card #${project.id} · ${project.company_name || ""} · ${project.division || ""}`,
    `Spark run ${run.id} · ${new Date().toISOString()}`,
    ``,
    `## Where things stand`,
    ``,
    r.headline ? `**${r.headline}**` : "",
    r.certitude ? `Certitude ${r.certitude.pct}% — ${r.certitude.reason || ""}` : "",
    run.ballMoved ? `\nBall moved: ${run.ballMoved}` : "",
    ``,
    `## Next step`,
    ``,
    r.next_step?.text || "(none recorded)",
    r.next_step?.first_action ? `\nFirst action: \`${r.next_step.first_action}\`` : "",
    ``,
    run.completed.length ? `## What Spark already did\n` : "",
    ...run.completed.map((c) => `- [${c.status}] ${c.summary}${c.evidence ? ` (${c.evidence})` : ""}`),
    (run.handoffs || []).length ? `\n## Left for this session\n` : "",
    ...(run.handoffs || []).map((h) => `- ${h.what}${h.why ? `\n  Why: ${h.why}` : ""}`),
    ``,
    `## Full report`,
    ``,
    r.body_md || "",
    ``,
  ];
  writeFileSync(file, lines.filter((l) => l !== "").join("\n") + "\n");
  return file;
}

// ── routes ─────────────────────────────────────────────────────────────────

function loadProject(req, res) {
  const id = parseInt(req.params.id, 10);
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "project not found" }); return null; }
  if (project.tmux_session === "operator" && !req.user?.is_admin) {
    res.status(404).json({ error: "project not found" });
    return null;
  }
  return project;
}

// For the ODA heartbeat executor (agents.js): share the concurrency cap and
// per-card busy check with human-started sparks.
export const SPARK_MAX_CONCURRENT = MAX_CONCURRENT;
// A "proposing" run is waiting on a human decision and its claude child has
// already exited, so it holds no compute — the executor may look past it.
export function activeSparkCount({ excludeProposing = false } = {}) {
  return [...runs.values()]
    .filter((r) => !r.finishedAt && (!excludeProposing || r.status !== "proposing"))
    .length;
}
export function getSparkRun(projectId) {
  return runs.get(String(projectId));
}

export function mountSpark(app) {
  recoverOrphanRuns();
  recordAbandonedRuns();

  app.get("/api/projects/:id/spark", (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const run = runs.get(String(project.id));
    res.json({
      run: publicRun(run),
      lastRun: run?.result ? null : latestResultOnDisk(project.id),
      canStart: !!req.user?.is_admin,
      model: MODEL,
    });
  });

  app.post("/api/projects/:id/spark", requireAdmin, async (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;

    const existing = runs.get(String(project.id));
    if (existing && !existing.finishedAt) {
      return res.status(409).json({ error: "a Spark run is already active for this card", runId: existing.id });
    }
    const active = [...runs.values()].filter((r) => !r.finishedAt).length;
    if (active >= MAX_CONCURRENT) {
      return res.status(429).json({ error: `${MAX_CONCURRENT} Spark runs are already going — wait for one to finish` });
    }

    try {
      const run = await startScan(project, req.user?.login || "");
      res.status(202).json({ runId: run.id, status: run.status });
    } catch (err) {
      console.error("POST /api/projects/:id/spark error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Approve/skip the proposed actions individually, then run the approved set.
  app.post("/api/projects/:id/spark/decide", requireAdmin, async (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const run = runs.get(String(project.id));
    if (!run || run.finishedAt) return res.status(404).json({ error: "no active Spark run" });
    if (run.status !== "proposing") return res.status(409).json({ error: `run is ${run.status}, not awaiting a decision` });

    const decisions = req.body?.decisions || {};
    const known = new Set(run.actions.map((a) => a.id));
    const unknown = Object.keys(decisions).filter((k) => !known.has(k));
    if (unknown.length) return res.status(400).json({ error: `unknown action(s): ${unknown.join(", ")}` });

    const note = String(req.body?.note || "").trim().slice(0, 2000);
    const approved = run.actions.filter((a) => decisions[a.id] === "do");
    if (!approved.length && note) {
      // Nothing approved but a correction supplied: that is not "stop", it is
      // "none of these, do this instead". Run the round so the note lands.
      startRound(run, decisions, note).catch(async (err) => {
        run.error = { message: err.message };
        emit(run, "error", run.error);
        await wrapUp(run);
      });
      return res.json({ ok: true, started: true, round: run.round, note: true });
    }
    if (!approved.length) {
      // Skipping everything with nothing to add is a legitimate answer, and it
      // ends the run.
      for (const a of run.actions) {
        run.actionStates[a.id] = { state: "skipped" };
        emit(run, "action_progress", { id: a.id, state: "skipped", detail: null });
      }
      pushLedger(run, "skip", "All proposed actions skipped.");
      await wrapUp(run);
      return res.json({ ok: true, started: false });
    }
    // Belt and braces: offerActions already keeps handoffs off the buttons, so
    // this only fires if one is approved by a hand-made request.
    if (approved.some((a) => normaliseTier(a.tier) === TIER_HANDOFF)) {
      return res.status(400).json({ error: "handoff actions go to a working session, not run here" });
    }

    startRound(run, decisions, note).catch(async (err) => {
      run.error = { message: err.message };
      emit(run, "error", run.error);
      await wrapUp(run);
    });
    // startRound increments synchronously before this line runs, so report the
    // round it actually started rather than the next one.
    res.json({ ok: true, started: true, round: run.round });
  });

  // There is no send-draft route on purpose. Sending is the one irreversible
  // outbound step and it stays outside OpenDia entirely: the act phase leaves
  // a Gmail draft, and the human sends it from Gmail.

  // Hand the card to a working session: write a brief, point the card at a
  // tmux session, and close the Spark timer so /od-go starts clean.
  app.post("/api/projects/:id/spark/handoff", requireAdmin, async (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const run = runs.get(String(project.id));
    if (!run) return res.status(404).json({ error: "no Spark run" });

    let brief = null;
    try {
      brief = writeHandoff(project, run);
    } catch (err) {
      return res.status(500).json({ error: `handoff brief failed: ${err.message}` });
    }
    pushLedger(run, "handoff", `Handoff brief written to ${brief}`);
    await wrapUp(run);
    res.json({ ok: true, brief, session: project.tmux_session || null });
  });

  // Stop. What that means depends on where the run is: abandoning a sweep
  // mid-flight is a cancel (the estimate is rewritten down to actual), but
  // closing a finished run that is merely waiting on a decision is an ordinary
  // finish and bills what it accrued.
  app.delete("/api/projects/:id/spark", requireAdmin, async (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const run = runs.get(String(project.id));
    if (!run || run.finishedAt) return res.status(404).json({ error: "no active Spark run" });

    if (run.status === "proposing" && run.result) {
      for (const a of run.actions) {
        if (run.actionStates[a.id]?.state === "pending") {
          run.actionStates[a.id] = { state: "skipped" };
          emit(run, "action_progress", { id: a.id, state: "skipped", detail: null });
        }
      }
      pushLedger(run, "skip", "Closed without running the remaining proposals.");
      await wrapUp(run);
      return res.json({ ok: true, closed: "finished" });
    }

    run.status = "cancelled";
    stopProc(run);
    pushLedger(run, "warn", "Run cancelled.");
    await closeSparkTimer(run, project, { failed: true, reason: "cancelled" });
    finishRun(run, "cancelled");
    res.json({ ok: true, closed: "cancelled" });
  });

  // Past runs are never pruned — every result.json stays on disk.
  app.get("/api/projects/:id/spark/history", (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const items = runsOnDisk(project.id).map((entry) => {
      const r = readRunResult(entry);
      if (!r) return null;
      if (entry.status === "interrupted") {
        const n = (r.fronts_reached || []).length;
        return {
          runId: entry.runId,
          at: entry.at,
          status: "interrupted",
          headline: n
            ? `Interrupted after ${n} of ${FRONTS.length} fronts — no recommendation`
            : "Interrupted before it got anywhere — no recommendation",
          reason: r.reason || null,
          certitude: null,
          ball: null,
        };
      }
      return {
        runId: entry.runId,
        at: entry.at,
        status: "done",
        headline: r.headline,
        certitude: r.certitude?.pct ?? null,
        ball: r.ball || null,
      };
    }).filter(Boolean);
    res.json(items);
  });

  app.get("/api/projects/:id/spark/history/:runId", (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!/^[\w-]+$/.test(req.params.runId)) return res.status(400).json({ error: "bad run id" });
    const entry = runsOnDisk(project.id).find((e) => e.runId === req.params.runId);
    if (!entry) return res.status(404).json({ error: "run not found" });
    const result = readRunResult(entry);
    if (!result) return res.status(500).json({ error: "result unreadable" });
    if (entry.status === "interrupted") {
      return res.status(409).json({ error: "that run was interrupted and produced no report", reason: result.reason || null });
    }
    res.json({ runId: entry.runId, at: entry.at, result });
  });

  app.get("/api/projects/:id/spark/stream", (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const run = runs.get(String(project.id));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    if (!run) {
      res.write(`event: snapshot\ndata: ${JSON.stringify({ status: "idle" })}\n\n`);
      res.end();
      return;
    }

    // The snapshot is the whole truth, so there is no event log to replay.
    res.write(`id: ${run.seq}\nevent: snapshot\ndata: ${JSON.stringify(publicRun(run))}\n\n`);
    if (run.finishedAt) { res.end(); return; }

    run.subs.add(res);
    // A named event, not a bare `: comment`: comments keep the socket warm but
    // fire nothing in EventSource, so the client could not tell a live-but-quiet
    // stream from a dead one. This is the client's liveness signal.
    const ka = setInterval(() => {
      try { res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`); } catch {}
    }, KEEPALIVE_MS);
    req.on("close", () => {
      clearInterval(ka);
      run.subs.delete(res);   // a client leaving never cancels the run
    });
  });
}
