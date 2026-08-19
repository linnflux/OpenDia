// spark.js — the Spark tab's server side.
//
// A Spark run is a headless Claude session scoped to one card. It sweeps every
// message front (email, Google Voice relays, Google Chat, Notion, timers,
// artifacts), then reports where the project stands, what happened lately, and
// exactly ONE next step with a self-rated certitude number.
//
// One next step, not a menu. The step carries a `route` saying who carries it
// out: "opendia" means the dashboard can do it on approval, "human" means it
// becomes a runroom and a working session. That single field replaced a
// per-action tier — with one recommendation there is nothing to rank, and the
// only question left is who does it.
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

import { getProjectById, getInboxItemsByProject, getProcessedGmailIds, updateProject, getAgentBySlug } from "./db.js";
import { getTimerEntriesForProject } from "./timers.js";
import { fetchNotionPage, searchNotionForProject, appendTimerLog } from "./notion.js";
import { searchRecentEmails } from "./gmail.js";
import { requireAdmin } from "./auth.js";
import { PORT } from "./config.js";
import {
  etNow, durationStr, minutesBetween, listRunningTimers,
  findTimerForSession, startTimerForProject, closeTimerEntry, setEntryEstimate
} from "./timerfile.js";
import { resolveFreeSession, writeSeedPlan, spawnSession, relocatePlan } from "./runroom_build.js";

const HOME = process.env.HOME || "/home/linnflux";
const CLAUDE_BIN = resolve(HOME, ".local", "bin", "claude");
const SPARK_ROOT = `${HOME}/OpenDia/spark`;

const MODEL = process.env.SPARK_MODEL || "opus";
// The model for act rounds — every phase after a human typed or clicked
// something. The scan is a scripted sweep and rides the cheap model; a round
// exists because a human decision entered the loop ("do this" or "you got it
// wrong, do this instead"), and interpreting that correction against the scan
// context is the highest-judgment moment in the whole flow. Deliberately
// defaults to opus even though SPARK_MODEL defaults lower in .env: rounds are
// rare (only a human triggers one — ODA heartbeats stop at proposing), so the
// premium is pocket change, and the stated preference is "cost more but work".
// Rounds also override an ODA's pinned model for the same reason.
// Cost note: caches are per-model, so a cross-model resume re-reads the scan
// context cold. Accepted — see above.
const ROUND_MODEL = process.env.SPARK_ROUND_MODEL || "opus";
const BUDGET_USD = process.env.SPARK_BUDGET_USD || "3.00";
const MAX_CONCURRENT = Number(process.env.SPARK_MAX_CONCURRENT || 2);
const HARD_KILL_MS = 20 * 60 * 1000;
const OVERRUN_MS = 15 * 60 * 1000;   // soft "past the estimate" signal
const RETAIN_MS = 10 * 60 * 1000;    // keep a finished run around for reconnects
const KEEPALIVE_MS = 20_000;
const BASE_ESTIMATE_MIN = 15;
const LOG_NOTION = process.env.SPARK_LOG_NOTION !== "false";

const MAX_ROUNDS = 4;
const MAX_STEPS_TOTAL = 8;
const ACCRUAL_PAUSE_MIN = 60;        // stop auto-accruing; ask the human first
// Below this the evidence did not hold up (fronts disagreed, or a decisive one
// could not be read). The panel demotes "Do it" and promotes "Adjust"; the
// server ships the threshold so both surfaces agree on one number.
const LOW_CERTITUDE = 60;
const IDLE_WARN_MS = 20 * 60 * 1000; // waiting on a decision
const IDLE_WRAP_MS = 30 * 60 * 1000;
// Agent-started runs stay decidable across the supervisor's nightly pass.
const AGENT_IDLE_WRAP_MS = Number(process.env.SPARK_AGENT_IDLE_WRAP_MS || 5 * 60 * 60 * 1000);

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

// There is no escapeAngles here any more, and that is deliberate.
//
// It existed because the panel rendered body_md through marked into innerHTML,
// which made a client's `<` a script-injection surface. body_md is gone and the
// panel renders every field as a JSX text node, so React escapes it — while the
// report's other consumers are all plain text: the handoff brief, the runroom
// plan's detail pane, the timer notes, and next_step on its way into SQLite.
// Escaping on the way out of here corrupted every one of those (a brief read
// `~/OpenDia/runrooms/&lt;session>/plan.json`). Escape at the render boundary,
// which React already does, not at the source.

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
    // The offered step is result.next_step; this is only its execution state
    // while a round is in flight.
    stepState: run.stepState,
    drafts: run.drafts,
    accruedMinutes: run.accruedMinutes,
    accrualPaused: run.accrualPaused,
    idleWrapAt: run.idleWrapAt || null,
    timerStarted: !!run.timer,
    timerNote: run.timerNote,
    costUsd: run.costUsd,
    model: run.agent?.model || MODEL,
    roundModel: ROUND_MODEL,
    lowCertitude: LOW_CERTITUDE,
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
// Exported (additive — mountSpark remains the only in-file caller) so the
// Mailroom's /context route can read a card's latest spark result without
// duplicating the runs-on-disk lookup.
export function runsOnDisk(projectId) {
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

export function readRunResult(entry) {
  try {
    const raw = JSON.parse(readFileSync(entry.file, "utf8"));
    // interrupted.json has its own shape and no recommendation to adapt.
    return entry.status === "interrupted" ? raw : adaptResult(raw);
  } catch { return null; }
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

/**
 * Rebuild what the rounds did, from the round files they already wrote.
 *
 * Without this a recovered run starts at round 0 with no outcomes: it would
 * grant four fresh rounds on top of the ones already spent, and close its timer
 * with notes justifying only the sweep, having dropped the ledger bullet for
 * every step actually carried out. All of it is on disk in round-N-result.json;
 * nothing new needs persisting, it just needs reading back.
 */
function restoreRounds(run) {
  let files = [];
  try {
    files = readdirSync(run.runDir)
      .filter((f) => /^round-\d+-result\.json$/.test(f))
      .sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10));
  } catch { return; }

  for (const name of files) {
    let raw;
    try { raw = JSON.parse(readFileSync(`${run.runDir}/${name}`, "utf8")); } catch { continue; }
    const v = validateRound(raw);
    if (!v.ok) continue;
    run.roundsUsed += 1;
    run.round = run.roundsUsed;
    if (v.round.outcome.status !== "none") {
      run.outcomes.push(v.round.outcome);
      run.stepsRun += 1;
    }
    for (const d of v.round.drafts || []) {
      if (d?.to && d?.body) run.drafts.push({ id: d.id || `d${run.drafts.length + 1}`, ...d });
    }
  }
  if (run.roundsUsed) {
    pushLedger(run, "note",
      `Restored ${run.roundsUsed} round(s) from disk — ${run.outcomes.length} step(s) already carried out.`);
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
      // Restore the agent identity, not just its name: without run.agent a
      // recovered ODA run loses its --allow-dir memory jail and its pinned
      // model/budget, so a later round spawns as if a human owned the run
      // (observed: a recovered scan's round was denied writing the agent's
      // own memory.md). started_by survives in the timer state file; the
      // rest lives in the agents table.
      if ((run.startedBy || "").startsWith("agent:")) {
        const agent = getAgentBySlug(run.startedBy.slice("agent:".length));
        if (agent) {
          run.agent = {
            slug: agent.slug,
            name: agent.name,
            model: agent.model,
            budgetUsd: agent.run_budget_usd,
          };
        }
      }
      // A run archived before schema 2 carries no `route` and no `recent`, and
      // it never passed through a validator. Adapt it here rather than teaching
      // every downstream reader two shapes.
      run.result = adaptResult(result);
      run.timer = { stateFile: file, marker: data.marker, dailyFile: data.file, task: data.task };
      run.timerChecked = true;
      run.accruedMinutes = data.estimated_minutes || BASE_ESTIMATE_MIN;
      for (const f of run.result.fronts || []) {
        if (FRONTS.includes(f.front)) {
          const state = f.state === "checked" ? "done" : f.state;
          run.fronts[f.front] = { state: FRONT_STATES.includes(state) ? state : "done", detail: f.reason || null };
        }
      }
      runs.set(String(projectId), run);
      pushLedger(run, "warn", "The dashboard restarted; this run was recovered from disk.");
      restoreRounds(run);
      offerNextStep(run);
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
      // Every step carried out adds its own bullet, so the notes justify the
      // accrued estimate rather than only the 15-minute sweep. The NEXT line
      // stays last.
      const stepBullets = run.outcomes
        .map((c) => c.note_bullet || c.summary)
        .filter(Boolean);
      const nextIdx = bullets.findIndex((b) => b.trim().startsWith("NEXT:"));
      const body = nextIdx === -1 ? bullets : bullets.slice(0, nextIdx);
      const tail = nextIdx === -1 ? [] : bullets.slice(nextIdx);
      notes = [...body, ...stepBullets, ...tail].join("\n");
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

    // An ODA scan is scheduled monitoring, not client-requested work: the
    // sweep itself bills nothing (plan-covered overhead), and the estimate
    // covers only the approved step if one was carried out. Human-triggered
    // Sparks keep the base estimate — a human judged the card needed the
    // attention.
    if ((run.startedBy || "").startsWith("agent:")) {
      estimate = Math.max(0, (run.accruedMinutes || BASE_ESTIMATE_MIN) - BASE_ESTIMATE_MIN);
      notes += `\nODA scan (${run.startedBy}) — sweep not billed; estimate covers approved work only.`;
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

/** There is one step in play, so the marker's id is ignored — the routine emits
 *  `action=step`, but an older cached routine emitting `action=a1` should still
 *  move the same indicator rather than being dropped on the floor. */
function applyStepMarker(run, state, detail) {
  const allowed = ["running", "done", "failed", "blocked"];
  if (!allowed.includes(state)) return;
  run.stepState = { state, detail: detail || run.stepState?.detail || null };
  emit(run, "step_progress", run.stepState);
  if (state === "running") {
    const text = run.result?.next_step?.text;
    if (text) setVerb(run, `Working on: ${text.slice(0, 60)}`);
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
        applyStepMarker(run, a[2], a[3] ? a[3].replace(/\\n/g, " ").trim() : "");
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

// The next step carries a route, not a tier. With one recommendation instead of
// a menu there is nothing left to rank, so the only open question is who carries
// it out. Written as a name rather than a number: the model emits this from a
// routine it read once, and "human" is self-describing where 3 was a mapping it
// had to recall — which is why the defaulting branch below exists at all.
const ROUTE_OPENDIA = "opendia";  // the dashboard performs it on approval
const ROUTE_HUMAN = "human";      // becomes a runroom and a working session
const ROUTES = [ROUTE_OPENDIA, ROUTE_HUMAN];

// Runs archived before schema 2 carry a per-action `tier`, and a model holding a
// cached routine may still emit one. `performed` and its numeric ancestor 1 map
// to opendia; everything else lands on human, including the long-dead
// dashboard-sends-an-email tier 2.
const LEGACY_ROUTES = {
  performed: ROUTE_OPENDIA, handoff: ROUTE_HUMAN,
  1: ROUTE_OPENDIA, 2: ROUTE_HUMAN, 3: ROUTE_HUMAN,
};

/** Coerce any route — named, legacy tier, or junk — to a known name. Unknown
 *  always resolves to human: guessing toward opendia would point automation at
 *  work that should have had a person in front of it, so the safe default is
 *  written into the fallback rather than left to depend on which value happens
 *  to sort last. */
function normaliseRoute(route) {
  if (ROUTES.includes(route)) return route;
  return LEGACY_ROUTES[route] || ROUTE_HUMAN;
}

/** One step or null — never an array, and never a half-populated object that
 *  the panel would have to defend itself against. */
function normaliseStep(step) {
  if (!step || typeof step !== "object" || !step.text) return null;
  return {
    text: String(step.text),
    why: step.why || "",
    owner: step.owner || "",
    route: normaliseRoute(step.route),
    estimated_minutes: Number.isFinite(step.estimated_minutes)
      ? Math.max(0, Math.round(step.estimated_minutes)) : 5,
    first_action: step.first_action || null,
    by_when: step.by_when || null,
    reversible: step.reversible !== false,
  };
}

function normaliseRecent(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && r.text)
    .slice(0, 20)
    .map((r) => ({
      date: r.date || null,
      front: FRONTS.includes(r.front) ? r.front : null,
      text: String(r.text),
    }));
}

/**
 * Upgrade a schema-1 report to the shape everything downstream now expects.
 *
 * Past runs are never pruned, so every archived result.json still has to render.
 * v1 scattered its evidence through `fronts[].findings[]` and offered a menu of
 * tiered actions instead of one routed step; the top action is the closest thing
 * it has to "what Spark would have done next", and its tier is the closest thing
 * to a route. `body_md` is deliberately kept rather than mapped away — the panel
 * shows it as the full report for v1 runs, so no archived detail is lost.
 *
 * Idempotent, which matters: recovery and history both call it, and a v2 result
 * has to survive passing through twice.
 */
function adaptResult(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== 1) return raw;

  const recent = Array.isArray(raw.recent)
    ? [...raw.recent]
    : (raw.fronts || []).flatMap((f) =>
        (f.findings || []).map((x) => ({
          date: x.date || f.as_of || null, front: f.front, text: x.text,
        })));
  recent.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  const top = (raw.actions || [])[0];
  // Everything mapped forward is dropped rather than carried alongside its
  // replacement: a wire shape with both `actions` and a routed `next_step` on it
  // invites the next reader to wonder which one is live. body_md is the one v1
  // field kept, because nothing in v2 replaces it.
  const { headline, ball, who_does_what, actions, proposed_next_step, ...rest } = raw;
  return {
    ...rest,
    schema: 2,
    schema_was: 1,
    where_it_stands: raw.where_it_stands || headline || "",
    recent,
    fronts: (raw.fronts || []).map(({ findings, ...f }) => f),   // findings are now `recent`
    next_step: raw.next_step ? {
      ...raw.next_step,
      why: raw.next_step.why || top?.why || "",
      // A v1 step has no route of its own. The top action's tier is the only
      // recorded signal about who was meant to act, and normaliseRoute sends
      // everything it does not recognise — including no signal at all — to human.
      route: normaliseRoute(raw.next_step.route ?? top?.tier),
      estimated_minutes: raw.next_step.estimated_minutes ?? top?.estimated_minutes ?? 5,
    } : null,
    card_next_step: raw.card_next_step ?? raw.proposed_next_step?.value ?? null,
  };
}

function validateResult(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object") return { ok: false, problems: ["no result JSON was produced"] };
  if (raw.__parseError) return { ok: false, problems: [`result.json is not valid JSON: ${raw.__parseError}`] };

  const r = adaptResult(raw);
  if (r.schema !== 2) problems.push(`unexpected schema ${JSON.stringify(raw.schema)}`);

  const pct = r?.certitude?.pct;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) problems.push("certitude.pct must be an integer 0-100");
  if (!r?.next_step?.text) problems.push("next_step.text is empty");
  if (!r?.where_it_stands) problems.push("where_it_stands is empty");
  if (!Array.isArray(r.fronts) || r.fronts.length === 0) problems.push("fronts is empty");
  else {
    const unknown = r.fronts.map((f) => f.front).filter((f) => !FRONTS.includes(f));
    if (unknown.length) problems.push(`unknown front(s): ${unknown.join(", ")}`);
  }
  if (r.recent && !Array.isArray(r.recent)) problems.push("recent must be an array");

  if (problems.length) return { ok: false, problems };

  // Soft lints — surfaced, never blocking. A good recommendation is not
  // withheld over grammar.
  const warnings = [];
  const prose = [r.where_it_stands, r.next_step?.text, r.next_step?.why, r.risk]
    .filter((s) => typeof s === "string").join("\n");
  if (PRONOUNS.test(prose)) warnings.push("contains personal pronouns");
  if ((r.certitude?.reason || "").length < 20) warnings.push("certitude reason is thin");
  if ((r.card_next_step || "").length > 100) warnings.push("card next step exceeds 100 chars");

  return {
    ok: true,
    result: {
      ...r,
      next_step: normaliseStep(r.next_step),
      recent: normaliseRecent(r.recent),
      style_warnings: warnings,
    },
  };
}

function validateRound(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, problems: ["no round JSON was produced"] };
  if (raw.__parseError) return { ok: false, problems: [`round JSON is invalid: ${raw.__parseError}`] };

  // A cached older routine reports completed[] and next_actions[] instead of one
  // outcome and one step. Fold both down rather than failing the round: the work
  // has already happened by the time this runs, and discarding the report would
  // lose the record of it.
  const o = raw.outcome || (Array.isArray(raw.completed) ? raw.completed[0] : null);
  const legacyNext = (raw.next_actions || [])[0];
  const step = raw.next_step ?? raw.recommendation_update?.next_step ?? (legacyNext ? {
    text: legacyNext.what || legacyNext.label,
    why: legacyNext.why,
    route: legacyNext.tier,
    estimated_minutes: legacyNext.estimated_minutes,
    reversible: legacyNext.reversible,
  } : null);

  if (!o && !step) {
    return { ok: false, problems: ["neither an outcome nor a revised next step was reported"] };
  }

  return {
    ok: true,
    round: {
      ...raw,
      outcome: {
        // "none" is the adjust path's correct answer, not a missing value.
        status: ["done", "failed", "blocked", "none"].includes(o?.status)
          ? o.status : (o ? "done" : "none"),
        summary: o?.summary || "",
        evidence: o?.evidence || null,
        minutes: Number.isFinite(o?.minutes) ? Math.max(0, Math.round(o.minutes)) : (o ? 5 : 0),
        note_bullet: o?.note_bullet || o?.summary || "",
      },
      recent_add: normaliseRecent(raw.recent_add),
      next_step: normaliseStep(step),
      certitude: raw.certitude || raw.recommendation_update?.certitude || null,
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

function spawnPhase(run, { prompt, deny, resume, model }) {
  const args = [
    "-p", prompt,
    ...(resume ? ["--resume", run.id] : ["--session-id", run.id]),
    // An explicit phase model outranks the ODA's pinned model on purpose —
    // see the ROUND_MODEL comment. The transcript is model-agnostic, so a
    // cross-model --resume continues the same session on the new model.
    "--model", model || run.agent?.model || MODEL,
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
    stepState: null,
    drafts: [],
    outcomes: [],
    accruedMinutes: 0,
    accrualPaused: false,
    roundsUsed: 0,
    stepsRun: 0,
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

    run.result = verdict.result;
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
    applyCardNextStep(run, project);
    emit(run, "result", run.result);
    offerNextStep(run);
  });

  return run;
}

/**
 * Put the recommendation on the card.
 *
 * This is the whole point of a scan, and for a long time it did not happen: the
 * report landed in a JSON file and the card only changed if a human clicked
 * Apply at the bottom of a long scroll. Keeping `next_step` true is Spark's job,
 * the field is a reversible one-liner, and a dated value is what feeds the
 * calendar — so the scan writes it, and says so in the ledger rather than
 * changing the board silently.
 */
function applyCardNextStep(run, project) {
  const value = run.result?.card_next_step;
  if (!value || typeof value !== "string") return;      // null means "leave the card alone"
  if (value === project.next_step) return;
  try {
    updateProject(project.id, { next_step: value });
    project.next_step = value;
    pushLedger(run, "done", `Card next step set to "${value}".`);
    // The calendar trigger lives on the Express PATCH route; this raw
    // updateProject bypasses it, so poke the debounced runner directly —
    // otherwise a dated next step waits up to 10 minutes for the cron poll.
    fetch(`http://127.0.0.1:${PORT}/api/calendar/sync`, { method: "POST" }).catch(() => {});
  } catch (err) {
    pushLedger(run, "warn", `Could not write the next step to the card: ${err.message}`);
  }
}

/**
 * Offer the one next step to the human and wait. The run stays open (and the
 * timer with it) until a decision arrives or the idle timeout wraps it up.
 *
 * A step routed `human` is still offered — it is the runroom button rather than
 * the do-it button. That is the difference from the tiered model this replaced,
 * where a handoff was filtered out of the buttons entirely and the run wrapped
 * up with nothing to click.
 */
function offerNextStep(run) {
  // The phase is over: neither the hard-kill nor the overrun verb applies
  // while a human is deciding.
  clearTimeout(run.killTimer);
  clearTimeout(run.overrunTimer);

  // Normalise here rather than trusting the caller: the recovery path feeds this
  // straight from a result.json on disk that never passed a validator. Coercion
  // is idempotent, so the already-validated callers are unaffected.
  const step = normaliseStep(run.result?.next_step);
  if (run.result) run.result = { ...run.result, next_step: step };
  run.stepState = null;

  if (run.roundsUsed >= MAX_ROUNDS) {
    pushLedger(run, "warn", `Round limit reached (${MAX_ROUNDS}) — remaining work belongs in a session.`);
  }

  const canOffer = !!step
    && run.roundsUsed < MAX_ROUNDS
    && run.stepsRun < MAX_STEPS_TOTAL
    && !run.accrualPaused;
  if (!canOffer) {
    wrapUp(run);
    return;
  }

  run.status = "proposing";
  run.phase = "propose";
  setVerb(run, null);
  emit(run, "next_step", { round: run.roundsUsed + 1, step });

  // Agent-started runs stay decidable much longer: they bill zero, hold no
  // compute (the claude child has exited), and the supervisor's nightly pass
  // arrives hours after the scan. Human runs keep the short window so a
  // walked-away decision never leaves a timer accruing.
  const isAgentRun = (run.startedBy || "").startsWith("agent:");
  const wrapMs = isAgentRun ? AGENT_IDLE_WRAP_MS : IDLE_WRAP_MS;
  const warnMs = Math.max(wrapMs - 10 * 60 * 1000, IDLE_WARN_MS);
  clearTimeout(run.idleWarnTimer);
  clearTimeout(run.idleWrapTimer);
  run.idleWarnTimer = setTimeout(() => {
    pushLedger(run, "warn", `Waiting on a decision — this Spark wraps up in ${Math.round((wrapMs - warnMs) / 60000)} minutes.`);
  }, warnMs);
  run.idleWrapAt = Date.now() + wrapMs;
  run.idleWrapTimer = setTimeout(() => {
    pushLedger(run, "warn", `No decision after ${Math.round(wrapMs / 60000)} minutes — wrapping up so the timer does not sit open.`);
    wrapUp(run);
  }, wrapMs);
}

async function wrapUp(run) {
  clearTimeout(run.idleWarnTimer);
  clearTimeout(run.idleWrapTimer);
  clearTimeout(run.overrunTimer);
  run.status = "wrapping";
  await closeSparkTimer(run, run.project);
  finishRun(run, "done");
}

/**
 * Run one act round. `intent` is "do" (carry the step out) or "adjust" (perform
 * nothing, re-recommend from the operator's correction).
 */
async function startRound(run, intent, note = "", opts = {}) {
  const project = run.project;
  const step = run.result?.next_step || null;
  run.roundsUsed += 1;
  run.round = run.roundsUsed;
  run.status = "acting";
  run.phase = "act";
  clearTimeout(run.idleWarnTimer);
  clearTimeout(run.idleWrapTimer);

  if (intent === "do") {
    run.stepState = { state: "running", detail: null };
    emit(run, "step_progress", run.stepState);
  }
  if (note) pushLedger(run, "note", `Correction: ${note}`);
  if (opts.decidedBy) {
    pushLedger(run, "note", `Approved by ${opts.decidedBy} — running on ${opts.model || ROUND_MODEL}.`);
  }

  const roundFile = `${run.runDir}/round-${run.round}.json`;
  const outPath = `${run.runDir}/round-${run.round}-result.json`;
  writeFileSync(roundFile, JSON.stringify({
    schema: 2,
    run_dir: run.runDir,
    out_path: outPath,
    round: run.round,
    intent,
    next_step: step,
    operator_note: note || null,
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

  setVerb(run, intent === "do"
    ? `Working on: ${(step?.text || "the approved step").slice(0, 60)}`
    : "Rethinking the next step");

  const proc = spawnPhase(run, {
    prompt:
      `Run /spark-act ${roundFile}\n\n` +
      // The note goes in the prompt as well as the round file. Buried in JSON
      // it reads as one more field; up here it reads as an instruction, which
      // is what it is. Same shape as the inbox dispatcher's operator
      // correction block.
      (note
        ? "## Operator Correction\n\nThe operator read the recommendation and "
          + "provided the following correction. It outranks everything below"
          + (intent === "adjust"
            ? " — perform nothing, and return a revised next step that does what "
              + "the correction actually asks for"
            : " — apply it to the approved step, and say in the summary how it "
              + "was applied")
          + `:\n\n${note}\n\n`
        : "") +
      "Invoked headlessly from the OpenDia dashboard Spark tab. There is no interactive user — " +
      "never ask a question and never wait for input. " +
      (intent === "do"
        ? "Carry out only the approved step, "
        : "Perform nothing this round, ") +
      "write the result JSON to the out_path named in the round file, then stop.",
    deny: DENY_ACT,
    resume: true,
    // A human just typed or clicked — the round runs on the judgment model.
    // A supervisor-approved round overrides to the execution model: the plan
    // was made on opus (scan) and reviewed on opus (supervisor); carrying it
    // out is the mechanical part.
    model: opts.model || ROUND_MODEL,
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
      if (intent === "do") {
        run.stepState = { state: "failed", detail: "no result reported" };
        emit(run, "step_progress", run.stepState);
      }
      await wrapUp(run);
      return;
    }

    applyRoundResult(run, round.round);
    offerNextStep(run);
  });
}

function applyRoundResult(run, data) {
  const o = data.outcome;
  if (o && o.status !== "none") {
    run.stepState = { state: o.status, detail: o.summary || null };
    emit(run, "step_progress", run.stepState);
    pushLedger(run, o.status,
      `${o.status === "done" ? "" : `${o.status}: `}${o.summary || "the step"}`);
    run.outcomes.push(o);
    run.stepsRun += 1;

    // Accrual: only completed work bills, and it stops climbing at the pause
    // threshold so a long chain becomes an explicit decision.
    if (o.status === "done" && run.timer && !run.accrualPaused) {
      run.accruedMinutes = Math.min(ACCRUAL_PAUSE_MIN, run.accruedMinutes + o.minutes);
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

  // `ball_moved` IS the new "where it stands" — the round just changed the state
  // of play, and that sentence is the update. It used to be carried as its own
  // field as well, which put the same sentence on screen twice and printed it
  // twice in the handoff brief. One fact, one place.
  if (run.result) {
    run.result = {
      ...run.result,
      where_it_stands: data.ball_moved || run.result.where_it_stands,
      // A round returning no step means the ball left our court; keep it null
      // rather than falling back to the step that was just carried out, which
      // would re-offer finished work.
      next_step: data.next_step,
      certitude: data.certitude || run.result.certitude,
      recent: [...(data.recent_add || []), ...(run.result.recent || [])].slice(0, 20),
      card_next_step: data.card_next_step ?? null,
    };
    applyCardNextStep(run, run.project);
    persistResult(run);
    emit(run, "result", run.result);
  }
}

/**
 * Write the current recommendation back over result.json.
 *
 * Rounds used to update only the in-memory copy, which left two things wrong:
 * a run recovered after a restart re-offered the step the *scan* produced,
 * discarding the revisions the operator had already steered; and history listed
 * every run by its opening guess rather than its conclusion. The file is the
 * durable record of what a run decided, so it has to follow the decision.
 *
 * Best-effort: the recommendation on screen is already correct, and losing the
 * disk copy is not worth failing a round that has done real work.
 */
function persistResult(run) {
  try {
    writeFileSync(`${run.runDir}/result.json`, JSON.stringify(run.result, null, 2));
  } catch (err) {
    console.error("spark: could not persist the updated result:", err.message);
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

/**
 * Write a session brief so a handoff lands with the Spark findings intact.
 *
 * `session` overrides the slug: the runroom builder resolves a free tmux name
 * before spawning, and the brief has to land under that name rather than under
 * whatever the card happens to point at right now.
 */
function writeHandoff(project, run, session = null) {
  const dir = `${HOME}/OpenDia/handoffs`;
  mkdirSync(dir, { recursive: true });
  const slug = (session || project.tmux_session || `card-${project.id}`).replace(/[^\w.-]/g, "-");
  const file = `${dir}/${slug}.md`;
  const r = run.result || {};
  const step = r.next_step;
  const lines = [
    `# ${project.name} — Spark handoff`,
    ``,
    `Card #${project.id} · ${project.company_name || ""} · ${project.division || ""}`,
    `Spark run ${run.id} · ${new Date().toISOString()}`,
    ``,
    `## Where things stand`,
    ``,
    r.where_it_stands || "(not recorded)",
    r.certitude ? `\nCertitude ${r.certitude.pct}% — ${r.certitude.reason || ""}` : "",
    ``,
    `## Next step`,
    ``,
    step?.text || "(none recorded)",
    step?.why ? `\nWhy: ${step.why}` : "",
    step?.first_action ? `\nFirst action: \`${step.first_action}\`` : "",
    step?.estimated_minutes ? `\nEstimated: ${step.estimated_minutes} minutes` : "",
    ``,
    (r.recent || []).length ? `## Recent activity\n` : "",
    ...(r.recent || []).slice(0, 10).map((x) =>
      `- ${x.date || "undated"}${x.front ? ` · ${x.front}` : ""} — ${x.text}`),
    r.risk ? `\n## Risk\n\n${r.risk}` : "",
    run.outcomes.length ? `\n## What Spark already did\n` : "",
    ...run.outcomes.map((c) => `- [${c.status}] ${c.summary}${c.evidence ? ` (${c.evidence})` : ""}`),
    // Archived v1 runs still carry their prose report; keep it rather than
    // dropping detail the sweep actually produced.
    r.body_md ? `\n## Full report\n\n${r.body_md}` : "",
    // Without this section a spawned session works from its own plan while
    // the room keeps displaying the seed step forever — the operator's window
    // goes stale the moment real work starts. The contract makes the session
    // the room's author, not just its subject.
    `\n## Runroom contract`,
    ``,
    `This session is bound to the runroom at ~/OpenDia/runrooms/${slug}/plan.json.`,
    `That file IS the operator's window into this work — file before prose:`,
    ``,
    `1. The moment your plan is approved, rewrite plan.json FIRST: replace the`,
    `   seeded step with your plan's real steps. Keep the existing top-level`,
    `   fields (runroom_version, title, card_id, card_name, company, division,`,
    `   tmux_session, created); steps are {n, title, actor: "opendia"|"human",`,
    `   state: "current"|"pending"|"done"|"failed", detail, note}; set`,
    `   current_step. (While in plan mode file writes are blocked — expected;`,
    `   the rewrite happens at approval, before anything else.)`,
    `2. Update the file at every step transition — started, done (evidence in`,
    `   the note), failed — before narrating in the pane.`,
    `3. When the work wraps (/od-stop), set status: "done".`,
    ``,
    `## Working with the operator`,
    ``,
    `- Clarifying questions go in batches — AskUserQuestion carries up to four`,
    `  at once. Serial single-question dialogs waste the operator's attention.`,
    `- If the work touches a server: never attempt writes (including the`,
    `  pre-work snapshot) while planning — plan mode blocks them by policy.`,
    `  Make "take the pre-work Lightsail snapshot" step 1 of the plan itself,`,
    `  and take it first thing after approval, before any other change.`,
    ``,
  ];
  writeFileSync(file, lines.filter((l) => l !== "").join("\n") + "\n");
  return file;
}

/**
 * Hand the next step to a human: seed a runroom plan, open a session on it, and
 * get Spark's timer out of the way.
 *
 * The ordering here is the whole function. The /runroom contract says room work
 * bills to the timer the session already runs and never opens a second one — so
 * Spark's entry must be closed, with its accrued minutes committed, BEFORE a
 * session exists that could start one of its own. Spawn first and every runroom
 * double-bills the card.
 *
 * The cost of that ordering is that a spawn failure leaves the run already
 * wrapped up. That is the right way round: the report is on disk in history, the
 * minutes are billed honestly, and retrying costs one click. The reverse failure
 * — two open timers on one card — is the mess /timer-merge exists to clean up.
 */
async function openRunroom(project, run) {
  const session = resolveFreeSession(project.tmux_session || project.name);
  const brief = writeHandoff(project, run, session);
  const plan = writeSeedPlan({ session, project, run });
  pushLedger(run, "handoff", `Runroom seeded at ${plan}`);
  pushLedger(run, "handoff", `Opening session "${session}" — this timer closes so the session owns the clock.`);

  await wrapUp(run);

  let final;
  try {
    final = spawnSession(session, brief);
  } catch (err) {
    throw new Error(
      `the plan was written to ${plan} but the session did not start (${err.message}). ` +
      `Open it by hand with: tmux new-session -s ${session}`
    );
  }

  let planFile = plan;
  if (final !== session) {
    // Something took the name between the check and the spawn.
    const moved = relocatePlan(session, final);
    if (moved) planFile = moved;
    else console.error(`spark: runroom plan for "${session}" is orphaned — the session spawned as "${final}"`);
  }

  try {
    updateProject(project.id, { tmux_session: final });
  } catch (err) {
    console.error("spark: could not point the card at the runroom session:", err.message);
  }

  return { session: final, plan: planFile, brief };
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

// Snapshot of live agent-started runs, for the supervisor executor.
export function listAgentSparkRuns() {
  return [...runs.values()]
    .filter((r) => !r.finishedAt && (r.startedBy || "").startsWith("agent:"))
    .map((r) => ({
      projectId: r.projectId,
      runId: r.id,
      status: r.status,
      startedBy: r.startedBy,
      startedAt: r.startedAt || null,
      projectName: r.project?.name || null,
      agent: r.agent ? { slug: r.agent.slug, name: r.agent.name } : null,
      result: r.result,
      roundsUsed: r.roundsUsed,
      stepsRun: r.stepsRun,
      outcomes: r.outcomes,
      drafts: r.drafts,
      idleWrapAt: r.idleWrapAt || null,
      runDir: r.runDir,
    }));
}

// Programmatic decide for the supervisor: the same checks the HTTP route
// applies, without an HTTP self-call. The server calls this only after its own
// guardrail checklist passes — the model that produced the verdict never can.
export async function superviseDecide(projectId, { intent, note = "", model = null, decidedBy = "" } = {}) {
  const run = runs.get(String(projectId));
  if (!run || run.finishedAt) return { ok: false, error: "no active run" };
  if (run.status !== "proposing") return { ok: false, error: `run is ${run.status}, not awaiting a decision` };
  const step = run.result?.next_step;
  if (intent === "do") {
    if (!step) return { ok: false, error: "no next step to carry out" };
    if (step.route !== ROUTE_OPENDIA) return { ok: false, error: "step is human-routed" };
  } else if (intent !== "adjust") {
    return { ok: false, error: `unsupported intent: ${intent}` };
  }
  startRound(run, intent, note, { model, decidedBy }).catch(async (err) => {
    run.error = { message: err.message };
    emit(run, "error", run.error);
    await wrapUp(run);
  });
  return { ok: true, round: run.round };
}

export function mountSpark(app) {
  recoverOrphanRuns();
  recordAbandonedRuns();

  app.get("/api/projects/:id/spark", (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const run = runs.get(String(project.id));
    // No lastRun here: the panel's history list already loads the newest run,
    // and reading one off disk on every mount was a fetch nothing rendered.
    res.json({
      run: publicRun(run),
      canStart: !!req.user?.is_admin,
      model: MODEL,
      lowCertitude: LOW_CERTITUDE,
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

  // One decision on one next step. `intent` says which:
  //   do      — carry it out here (only a step routed "opendia" qualifies)
  //   runroom — seed a plan, open a session, and hand the work over
  //   adjust  — perform nothing; re-recommend from the operator's correction
  //   done    — the operator attests the step is already done (any route);
  //             recorded as an outcome with their note as evidence, no round
  //   stop    — close the run without doing anything
  app.post("/api/projects/:id/spark/decide", requireAdmin, async (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const run = runs.get(String(project.id));
    if (!run || run.finishedAt) return res.status(404).json({ error: "no active Spark run" });
    if (run.status !== "proposing") return res.status(409).json({ error: `run is ${run.status}, not awaiting a decision` });

    const intent = String(req.body?.intent || "").trim();
    const note = String(req.body?.note || "").trim().slice(0, 2000);
    const step = run.result?.next_step;
    if (!["do", "runroom", "adjust", "done", "stop"].includes(intent)) {
      return res.status(400).json({ error: `unknown intent ${JSON.stringify(intent)}` });
    }

    if (intent === "stop") {
      pushLedger(run, "skip", "Closed without acting on the recommendation.");
      await wrapUp(run);
      return res.json({ ok: true, started: false });
    }

    // The operator did the step themselves (sent the email, made the call,
    // clicked the thing) and is reporting the fact — no model needs to run.
    // Their word is the evidence; a scheduled email counts as sent.
    if (intent === "done") {
      if (!step) return res.status(409).json({ error: "this run has no next step to mark done" });
      run.outcomes.push({
        status: "done",
        summary: `Operator reports the step done${note ? `: ${note}` : "."}`,
        evidence: note || "operator attestation",
        minutes: 0,
        note_bullet: `Operator performed: ${step.text}`.slice(0, 200),
      });
      run.stepsRun += 1;
      pushLedger(run, "done", `Operator reports the step done${note ? ` — ${note}` : "."}`);
      await wrapUp(run);
      return res.json({ ok: true, started: false, done: true });
    }

    if (intent === "adjust") {
      // The correction IS the instruction, so there is nothing to run without
      // one. spark-act reads an empty approval plus a note as "none of this —
      // do this instead", which is exactly this path.
      if (!note) return res.status(400).json({ error: "an adjustment needs a note" });
      startRound(run, "adjust", note).catch(async (err) => {
        run.error = { message: err.message };
        emit(run, "error", run.error);
        await wrapUp(run);
      });
      return res.json({ ok: true, started: true, round: run.round });
    }

    if (!step) return res.status(409).json({ error: "this run has no next step to act on" });

    if (intent === "runroom") {
      try {
        const room = await openRunroom(project, run);
        return res.json({ ok: true, started: false, ...room });
      } catch (err) {
        console.error("spark: runroom failed:", err.message);
        return res.status(500).json({ error: `could not open the runroom: ${err.message}` });
      }
    }

    // Belt and braces: the panel only shows "Do it" for an opendia step, so this
    // fires on a hand-made request. Routing is fail-closed upstream, which makes
    // this the second of two places that have to agree — deliberately.
    if (step.route !== ROUTE_OPENDIA) {
      return res.status(400).json({ error: "a step routed to a human goes to a runroom, not run here" });
    }

    startRound(run, "do", note).catch(async (err) => {
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
      pushLedger(run, "skip", "Closed without acting on the recommendation.");
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
  // The operator did an expired recommendation's step themselves and is
  // reporting the fact after the run wrapped. The live-run "done" intent needs
  // a proposing run; this is its history-side twin — attestation recorded in
  // the run dir for the audit trail, completion note written to the card.
  app.post("/api/projects/:id/spark/attest", requireAdmin, (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    const entry = runsOnDisk(project.id).find((e) => e.status !== "interrupted");
    const r = entry ? readRunResult(entry) : null;
    const step = r?.next_step;
    if (!step?.text) return res.status(404).json({ error: "no past recommendation to attest" });
    try {
      writeFileSync(`${SPARK_ROOT}/${project.id}/${entry.runId}/operator-attest.json`, JSON.stringify({
        at: new Date().toISOString(),
        by: req.user?.login || "",
        note,
        step_text: step.text,
      }, null, 2));
    } catch {}
    const today = etNow().iso.slice(0, 10);
    const done = `${today}: Done — operator performed: ${step.text}`.slice(0, 100);
    try {
      updateProject(project.id, { next_step: done });
      fetch(`http://127.0.0.1:${PORT}/api/calendar/sync`, { method: "POST" }).catch(() => {});
    } catch {}
    res.json({ ok: true, next_step: done });
  });

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
        // The list needs one line to identify a run by. The next step is what a
        // past Spark is actually remembered for; where_it_stands is the fallback
        // for a run that produced no step at all.
        headline: r.next_step?.text || r.where_it_stands || "(no recommendation)",
        certitude: r.certitude?.pct ?? null,
        route: r.next_step?.route || null,
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
