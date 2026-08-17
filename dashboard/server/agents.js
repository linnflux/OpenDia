// agents.js — OpenDia Agents (ODAs): scheduled scan-and-propose agents.
//
// An ODA is a named agent with a working schedule (ET), a heartbeat interval,
// an expertise/persona markdown + scratchpad memory markdown on disk, a
// per-heartbeat token limit, and a set of assigned project cards. A heartbeat
// runs one Spark scan per assigned card, sequentially, with the agent's
// identity injected — so proposals land in each card's existing Spark tab and
// every safety control (guard hook, deny lists, budget, hard kill) is Spark's.
//
// Two executor shape decisions worth knowing:
//
//   * A spark run that reaches "proposing" is done as far as the agent is
//     concerned: the proposals are staged on the card, the claude child has
//     exited, and the run merely idles awaiting a human. Waiting for
//     finishedAt would stall the sweep up to 30 minutes per card.
//
//   * The token limit is enforced between cards, not inside a run — the CLI
//     only speaks USD (--max-budget-usd is the per-run backstop). Exceeding
//     the limit mid-heartbeat stops further cards until the next heartbeat.

import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "fs";

import { requireAdmin } from "./auth.js";
import {
  getAllAgents, getAgentById, createAgent, updateAgent, markAgentHeartbeat,
  getAgentProjects, assignAgentProject, unassignAgentProject,
  insertAgentRun, updateAgentRun, getAgentRuns, interruptStaleAgentRuns,
  getProjectById, getProjectsByStatuses, markAgentDigest, getAgentRunsSince,
} from "./db.js";
import {
  startScan, activeSparkCount, getSparkRun, SPARK_MAX_CONCURRENT,
  listAgentSparkRuns, superviseDecide,
} from "./spark.js";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { createWriteStream } from "fs";
import { resolve as resolvePath } from "path";
import { etNow } from "./timerfile.js";
import { notifyChat } from "./chat_notify.js";
import { runClaude } from "./ai.js";

const HOME = process.env.HOME || "/home/linnflux";
const AGENTS_ROOT = `${HOME}/OpenDia/agents`;

const HEARTBEAT_MAX_MS = Number(process.env.AGENT_HEARTBEAT_MAX_MS || 45 * 60 * 1000);
const SUPERVISED_ROUND_MODEL = process.env.SPARK_SUPERVISED_ROUND_MODEL || "sonnet";
const REVIEW_KILL_MS = 15 * 60 * 1000;      // per supervisor model invocation
const ROUND_SETTLE_MAX_MS = 25 * 60 * 1000; // > spark's 20-min hard kill
const CLAUDE_BIN = resolvePath(HOME, ".local", "bin", "claude");

// The supervisor is strictly read-only: same list spark uses for scans —
// no edits, no drafts, no Notion writes, no subagents. Its only output is the
// verdict file, and Bash is fenced by spark_guard --reviewer (which also
// blocks non-GET HTTP so the loopback-admin API is out of reach).
const DENY_REVIEW = [
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
const CARD_WAIT_MAX_MS = 25 * 60 * 1000;   // > spark's 20-min hard kill
const CONCURRENCY_WAIT_MAX_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
const KEEPALIVE_MS = 20_000;
const VALID_MODELS = new Set(["opus", "sonnet", "haiku"]);

// Map<agentId, LiveHeartbeat>
const live = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SQLite datetime('now') is UTC with no zone marker; user-facing text is ET.
function fmtET(sqliteUtc) {
  if (!sqliteUtc) return "";
  const d = new Date(sqliteUtc.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return sqliteUtc;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) + " ET";
}

// ── slug + scaffold ────────────────────────────────────────────────────────

function slugify(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-agent$/, "")
    .slice(0, 40) || "agent";
}

function agentDir(slug) {
  return `${AGENTS_ROOT}/${slug}`;
}

function scaffoldAgentFiles(agent) {
  const dir = agentDir(agent.slug);
  mkdirSync(dir, { recursive: true });
  const agentMd = `${dir}/agent.md`;
  const memoryMd = `${dir}/memory.md`;
  if (!existsSync(agentMd)) {
    writeFileSync(agentMd,
`---
name: ${agent.name}
slug: ${agent.slug}
description: One-line role summary
metadata:
  type: oda-persona
---
# Expertise
(what this agent is good at — fill in before enabling)

# Operating rules
- Scan & propose only. Draft actions; a human approves anything external.
- Prefer updating next_step over proposing busywork.
`);
  }
  if (!existsSync(memoryMd)) {
    writeFileSync(memoryMd,
`---
name: ${agent.name} — memory
metadata:
  type: oda-memory
---
<!-- Scratchpad. Dated bullets, newest first. HARD MAX 60 lines: prune the oldest when adding. -->
`);
  }
}

function readAgentFile(slug, file) {
  const path = `${agentDir(slug)}/${file}`;
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

// ── schedule gate ──────────────────────────────────────────────────────────

// JS getDay() convention: 0=Sun..6=Sat, matching schedule_days.
function etDayOfWeek(now) {
  return new Date(`${now.YYYY}-${now.MM}-${now.DD}T12:00:00`).getDay();
}

function inScheduleWindow(agent, now = etNow()) {
  const days = String(agent.schedule_days || "").split(",").map((d) => Number(d.trim()));
  const hhmm = `${now.HH}:${now.mm}`;
  const { schedule_start: start, schedule_end: end } = agent;

  // Same-day window (start < end): the common case — both bounds on one day.
  if (start <= end) {
    return days.includes(etDayOfWeek(now)) && start <= hhmm && hhmm < end;
  }

  // Midnight-crossing window (start > end, e.g. 20:00–01:00). A plain
  // `start <= now < end` can never be true when start sorts after end, so
  // without this branch such a window silently never fires — the agent just
  // logs off-schedule all night (how this bug was found: both agents were
  // set to evening-past-midnight windows and went dark at 22:47).
  //
  // The window is two slices: the evening side (now >= start) belongs to the
  // scheduled day itself; the early-morning side (now < end) belongs to the
  // PREVIOUS day's window — a Friday-only 21:00–01:30 must cover Saturday's
  // first ninety minutes, and must NOT fire early Friday unless Thursday is
  // also scheduled.
  const today = etDayOfWeek(now);
  if (hhmm >= start) return days.includes(today);
  if (hhmm < end) return days.includes((today + 6) % 7);
  return false;
}

function minutesSinceLastHeartbeat(agent) {
  if (!agent.last_heartbeat_at) return Infinity;
  // last_heartbeat_at is SQLite datetime('now') — UTC without a zone marker.
  return (Date.now() - new Date(agent.last_heartbeat_at + "Z").getTime()) / 60000;
}

// ── SSE plumbing (spark.js shape) ──────────────────────────────────────────

function emit(state, event, data) {
  state.seq += 1;
  const frame = `id: ${state.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of state.subs) {
    try { res.write(frame); } catch {}
  }
}

function pushLog(state, level, text) {
  const entry = { at: new Date().toISOString(), level, text };
  state.log.push(entry);
  if (state.log.length > 200) state.log.shift();
  emit(state, "log", entry);
}

function publicLive(state) {
  if (!state) return null;
  return {
    runId: state.runId,
    trigger: state.trigger,
    status: state.status,
    startedAt: state.startedAt,
    currentProject: state.currentProject,
    tokens: state.tokens,
    costUsd: state.costUsd,
    cardsDone: state.cardsDone,
    cardsTotal: state.cardsTotal,
    log: state.log.slice(-50),
  };
}

// ── roster resolution ──────────────────────────────────────────────────────

const NEXT_STEP_DATE_RE = /^\s*(\d{4}-\d{2}-\d{2})/;
const RESCAN_GUARD_MS = 24 * 60 * 60 * 1000;

// Newest spark run dir mtime for a card — the durable "last scanned" signal.
function lastSparkAt(projectId) {
  try {
    const dir = `${HOME}/OpenDia/spark/${projectId}`;
    let newest = 0;
    for (const name of readdirSync(dir)) {
      const t = statSync(`${dir}/${name}`).mtimeMs;
      if (t > newest) newest = t;
    }
    return newest;
  } catch { return 0; }
}

// An agent's card list. Static mode reads the hand-picked join table; query
// mode recomputes from the board every call, which makes the roster
// self-draining: a scan that writes a future-dated next step removes the card
// from a 'stale' query, and the card re-enters when that date passes. The 24h
// guard stops a card whose scan produced no date from looping every heartbeat.
function rosterFor(agent) {
  if (agent.roster_mode !== "query") return getAgentProjects(agent.id);
  const statuses = String(agent.query_status || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  let rows = getProjectsByStatuses(statuses);
  if (agent.query_next_step === "stale") {
    const now = etNow();
    const today = `${now.YYYY}-${now.MM}-${now.DD}`;
    rows = rows.filter((r) => {
      const m = NEXT_STEP_DATE_RE.exec(r.next_step || "");
      return !m || m[1] < today;
    });
  }
  const guardBefore = Date.now() - RESCAN_GUARD_MS;
  rows = rows.filter((r) => lastSparkAt(r.id) < guardBefore);
  // Stalest first: undated ("" sorts lowest), then oldest date, then oldest
  // card touch.
  rows.sort((a, b) => {
    const da = NEXT_STEP_DATE_RE.exec(a.next_step || "")?.[1] || "";
    const dbb = NEXT_STEP_DATE_RE.exec(b.next_step || "")?.[1] || "";
    if (da !== dbb) return da < dbb ? -1 : 1;
    return (a.updated_at || "").localeCompare(b.updated_at || "");
  });
  return rows;
}

// ── heartbeat executor ─────────────────────────────────────────────────────

function tokensFromUsage(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.output_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
}

function pendingApprovalsFor(projects) {
  let n = 0;
  for (const p of projects) {
    const run = getSparkRun(p.id);
    if (run && !run.finishedAt && run.status === "proposing") n += 1;
  }
  return n;
}

async function waitForScan(sparkRun) {
  const deadline = Date.now() + CARD_WAIT_MAX_MS;
  while (Date.now() < deadline) {
    if (sparkRun.finishedAt || sparkRun.status === "proposing") return;
    await sleep(POLL_MS);
  }
}

function startHeartbeat(agent, trigger) {
  const runId = randomUUID();
  // Supervisors log every pass as trigger "review", but whether it defers the
  // schedule depends on how it was STARTED — a manual Run now must never push
  // the scheduled pass, same rule as scanners.
  const manual = trigger === "manual";
  if (agent.role === "supervisor") trigger = "review";
  const state = {
    runId,
    agentId: agent.id,
    manual,
    trigger,
    status: "running",
    startedAt: Date.now(),
    currentProject: null,
    tokens: 0,
    costUsd: 0,
    cardsDone: 0,
    cardsTotal: 0,
    seq: 0,
    log: [],
    subs: new Set(),
  };
  live.set(agent.id, state);
  insertAgentRun({ id: runId, agentId: agent.id, trigger, status: "running" });

  runHeartbeat(agent, state).catch((err) => {
    console.error(`agents: heartbeat ${runId} crashed:`, err);
    updateAgentRun(runId, { status: "error", summary: `heartbeat crashed: ${err.message}`, finished: true });
    finishHeartbeat(agent, state, "error");
  });

  return state;
}

async function runHeartbeat(agent, state) {
  if (agent.role === "supervisor") return runSupervisorHeartbeat(agent, state);
  const assigned = rosterFor(agent);
  const touchHeartbeat = !state.manual;
  if (assigned.length === 0) {
    const emptyMsg = agent.roster_mode === "query"
      ? "No cards match the roster query." : "No projects assigned.";
    updateAgentRun(state.runId, { status: "done", summary: emptyMsg, finished: true });
    markAgentHeartbeat(agent.id, agent.rotation_cursor, { touchHeartbeat });
    finishHeartbeat(agent, state, "done");
    return;
  }

  // Static rosters rotate so a budget-exhausted heartbeat resumes where it
  // left off; a query roster is already ordered stalest-first and self-drains,
  // so rotation would only scramble it.
  let cards;
  if (agent.roster_mode === "query") {
    cards = assigned;
  } else {
    const cursor = agent.rotation_cursor % assigned.length;
    cards = [...assigned.slice(cursor), ...assigned.slice(0, cursor)];
  }
  if (agent.max_cards_per_heartbeat > 0) {
    cards = cards.slice(0, agent.max_cards_per_heartbeat);
  }
  state.cardsTotal = cards.length;
  pushLog(state, "info", `Heartbeat started — ${cards.length} card(s), token limit ${agent.heartbeat_token_limit}.`);

  const details = [];
  let ran = 0;
  let finalStatus = "done";

  for (const card of cards) {
    if (Date.now() - state.startedAt > HEARTBEAT_MAX_MS) {
      pushLog(state, "warn", "Heartbeat wall clock exceeded — stopping.");
      finalStatus = "error";
      break;
    }

    // A human (or a previous heartbeat) already has a run open on this card.
    const existing = getSparkRun(card.id);
    if (existing && !existing.finishedAt) {
      details.push({ project_id: card.id, name: card.name, status: "skipped", reason: "spark already active" });
      pushLog(state, "info", `Skipped ${card.name} — a Spark run is already open on that card.`);
      continue;
    }

    // Share the compute cap with human-started sparks. "Proposing" runs hold
    // no compute, so they don't count against it here.
    const capDeadline = Date.now() + CONCURRENCY_WAIT_MAX_MS;
    while (activeSparkCount({ excludeProposing: true }) >= SPARK_MAX_CONCURRENT) {
      if (Date.now() > capDeadline) break;
      await sleep(15_000);
    }
    if (activeSparkCount({ excludeProposing: true }) >= SPARK_MAX_CONCURRENT) {
      details.push({ project_id: card.id, name: card.name, status: "skipped", reason: "concurrency cap" });
      pushLog(state, "warn", `Skipped ${card.name} — Spark concurrency cap held for 10 minutes.`);
      continue;
    }

    const project = getProjectById(card.id);
    if (!project) continue;

    state.currentProject = { id: card.id, name: card.name };
    emit(state, "progress", publicLive(state));
    pushLog(state, "info", `Scanning ${card.name}…`);

    let sparkRun;
    try {
      sparkRun = await startScan(project, `agent:${agent.slug}`, {
        agent: {
          slug: agent.slug,
          name: agent.name,
          model: agent.model,
          budgetUsd: agent.run_budget_usd,
        },
      });
      await waitForScan(sparkRun);
    } catch (err) {
      details.push({ project_id: card.id, name: card.name, status: "error", reason: err.message });
      pushLog(state, "warn", `Scan of ${card.name} failed: ${err.message}`);
      continue;
    }

    const tokens = tokensFromUsage(sparkRun.usage);
    state.tokens += tokens;
    state.costUsd += sparkRun.costUsd || 0;
    state.cardsDone += 1;
    ran += 1;

    // A scan produces one next step, not a menu, so "awaiting a decision" is a
    // yes/no per card rather than a count of proposals.
    const step = sparkRun.result?.next_step || null;
    const awaiting = step ? 1 : 0;
    details.push({
      project_id: card.id,
      name: card.name,
      spark_run_id: sparkRun.id,
      status: sparkRun.error ? "error" : sparkRun.status,
      tokens,
      cost_usd: sparkRun.costUsd || 0,
      next_step: step,
      route: step?.route || null,
      awaiting,
    });
    updateAgentRun(state.runId, {
      tokensUsed: state.tokens,
      costUsd: state.costUsd,
      detail: JSON.stringify(details),
    });
    pushLog(state, "info",
      `${card.name}: ${sparkRun.error ? "error" : "scanned"} — ${tokens} tokens` +
      (step ? `, next step awaiting a decision (${step.route}).` : ", no next step."));
    state.currentProject = null;
    emit(state, "progress", publicLive(state));

    if (state.tokens >= agent.heartbeat_token_limit) {
      pushLog(state, "warn", `Token limit reached (${state.tokens}/${agent.heartbeat_token_limit}) — pausing until next heartbeat.`);
      finalStatus = "budget_exhausted";
      break;
    }
  }

  const proposals = details.reduce((n, d) => n + (d.awaiting || 0), 0);
  const summary =
    `Swept ${state.cardsDone}/${cards.length} card(s), ${proposals} next step(s) awaiting a decision` +
    (finalStatus === "budget_exhausted" ? " — token limit hit" : "") +
    (finalStatus === "error" ? " — stopped early" : "") + ".";

  updateAgentRun(state.runId, {
    status: finalStatus,
    tokensUsed: state.tokens,
    costUsd: state.costUsd,
    summary,
    detail: JSON.stringify(details),
    finished: true,
  });
  const nextCursor = agent.roster_mode === "query"
    ? agent.rotation_cursor
    : (agent.rotation_cursor + ran) % assigned.length;
  markAgentHeartbeat(agent.id, nextCursor, { touchHeartbeat });

  const notifyNow = agent.chat_mode !== "quiet" && agent.chat_mode !== "digest";
  if (notifyNow && (proposals > 0 || finalStatus !== "done")) {
    // Per-card deep links straight to the Spark tab, where approval lives.
    // Google Chat webhook text renders <url|label> as a link.
    const base = (process.env.DASHBOARD_PUBLIC_URL || "").replace(/\/$/, "");
    const cardLinks = base
      ? details
          .filter((d) => d.spark_run_id)
          .map((d) => `<${base}/?project=${d.project_id}&tab=spark|${d.name}>${d.route ? ` (${d.route})` : ""}`)
          .join(", ")
      : "";
    await notifyChat(agent.chat_webhook_url,
      `${agent.name}: ${summary}` +
      (cardLinks ? `\nReview: ${cardLinks}` : proposals > 0 ? " Open the dashboard to review." : ""));
  }
  finishHeartbeat(agent, state, finalStatus, summary);
}

function finishHeartbeat(agent, state, status, summary = "") {
  state.status = status;
  emit(state, "done", { status, summary, tokens: state.tokens, costUsd: state.costUsd });
  for (const res of state.subs) { try { res.end(); } catch {} }
  state.subs.clear();
  live.delete(agent.id);
}

// ── supervisor executor ────────────────────────────────────────────────────
//
// A supervisor reviews other agents' spark runs instead of scanning cards.
// One session per heartbeat, two invocations: the review pass writes verdicts,
// the SERVER executes them through superviseDecide after its own guardrail
// checklist (the model never decides), then a QA pass on --resume verifies
// outcomes. Shadow mode (autopilot=0) records would-approve and escalates
// everything — the trust ramp before granting auto-approve.

function reviewDirFor(agent, runId) {
  return `${agentDir(agent.slug)}/reviews/${runId}`;
}

function spawnSupervisor(agent, state, reviewDir, { briefFile, resume }) {
  const guardFile = `${reviewDir}/guard.json`;
  writeFileSync(guardFile, JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit",
        hooks: [{
          type: "command",
          command: `python3 ${HOME}/OpenDia/scripts/spark_guard.py --run-dir ${reviewDir} --reviewer`,
        }],
      }],
    },
  }, null, 2));

  const args = [
    "-p",
    `Run /supervise ${briefFile}\n\n` +
    "Invoked headlessly by the OpenDia agent scheduler. There is no interactive " +
    "user — never ask a question and never wait for input. Write the verdict " +
    "JSON to the out_path named in the brief, then stop.",
    ...(resume ? ["--resume", state.runId] : ["--session-id", state.runId]),
    "--model", agent.model,
    "--permission-mode", "bypassPermissions",
    "--disallowedTools", DENY_REVIEW.join(" "),
    "--output-format", "stream-json",
    "--verbose",
    "--max-budget-usd", String(agent.run_budget_usd),
    "--add-dir", `${HOME}/OpenDia`,
    "--settings", guardFile,
  ];

  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, args, { cwd: `${HOME}/OpenDia`, stdio: ["ignore", "pipe", "pipe"] });
    const rawLog = createWriteStream(`${reviewDir}/raw.log`, { flags: "a" });
    createInterface({ input: proc.stdout }).on("line", (line) => {
      rawLog.write(line + "\n");
      try {
        const msg = JSON.parse(line);
        if (msg.type === "result") {
          if (typeof msg.total_cost_usd === "number") state.costUsd += msg.total_cost_usd;
          if (msg.usage) state.tokens += tokensFromUsage(msg.usage);
        }
      } catch {}
    });
    proc.stderr.on("data", (d) => rawLog.write(d));
    const kill = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, REVIEW_KILL_MS);
    proc.on("error", () => { clearTimeout(kill); resolve({ ok: false }); });
    proc.on("close", (code) => { clearTimeout(kill); resolve({ ok: code === 0 }); });
  });
}

function readVerdicts(path, phase) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw.verdicts)) return null;
    return raw.verdicts.filter((v) => Number.isInteger(v.project_id) || /^\d+$/.test(String(v.project_id)));
  } catch {
    return null;
  }
}

// Every rule a model verdict must clear before the server will act on it.
// Returns { ok, reason } — the reason lands verbatim in the escalation line.
function guardrailCheck(agent, verdict, approvals) {
  if (!agent.autopilot) return { ok: false, reason: "shadow mode" };
  if (verdict.verdict !== "approve") return { ok: false, reason: `verdict: ${verdict.verdict}` };
  const run = getSparkRun(verdict.project_id);
  if (!run || run.finishedAt) return { ok: false, reason: "run no longer decidable" };
  if (run.status !== "proposing") return { ok: false, reason: `run is ${run.status}` };
  if (!(run.startedBy || "").startsWith("agent:")) return { ok: false, reason: "not an agent run" };
  if (run.startedBy === `agent:${agent.slug}`) return { ok: false, reason: "own run" };
  const step = run.result?.next_step;
  if (!step) return { ok: false, reason: "no next step" };
  if (step.route !== "opendia") return { ok: false, reason: "human-routed" };
  if (step.reversible !== true) return { ok: false, reason: "not reversible" };
  const pct = run.result?.certitude?.pct;
  if (!Number.isInteger(pct) || pct < agent.min_certitude) {
    return { ok: false, reason: `certitude ${pct ?? "?"} < ${agent.min_certitude}` };
  }
  if (approvals >= agent.max_auto_approvals) return { ok: false, reason: "approval cap reached" };
  if (activeSparkCount({ excludeProposing: true }) >= SPARK_MAX_CONCURRENT) {
    return { ok: false, reason: "spark concurrency cap" };
  }
  return { ok: true, reason: null };
}

async function waitForRunSettled(projectId) {
  const deadline = Date.now() + ROUND_SETTLE_MAX_MS;
  while (Date.now() < deadline) {
    const run = getSparkRun(projectId);
    if (!run || run.finishedAt || run.status === "proposing") return run || null;
    await sleep(POLL_MS);
  }
  return getSparkRun(projectId) || null;
}

// A review is identified by run + round count: an escalated run deliberately
// stays "proposing" for hours, and re-reviewing it every heartbeat would just
// burn tokens and repeat the same Chat report. Only a new act round (rounds
// count moved) makes a run worth a second look.
const reviewKey = (runId, rounds) => `${runId}:${rounds || 0}`;

function seenReviewKeys(agent) {
  const since = new Date(Date.now() - 48 * 3600 * 1000)
    .toISOString().slice(0, 19).replace("T", " ");
  const seen = new Set();
  for (const run of getAgentRunsSince(agent.id, since)) {
    if (run.trigger !== "review") continue;
    try {
      for (const r of JSON.parse(run.detail || "{}").reviewed_runs || []) {
        // A shadow review was a rehearsal: once autopilot is on, it must not
        // suppress the real pass that can actually execute the approvals.
        if (agent.autopilot && r.shadow) continue;
        seen.add(reviewKey(r.spark_run_id, r.rounds_used));
      }
    } catch {}
  }
  return seen;
}

async function runSupervisorHeartbeat(agent, state) {
  const touchHeartbeat = !state.manual;
  const proposing = listAgentSparkRuns().filter((r) =>
    r.status === "proposing" &&
    r.startedBy !== `agent:${agent.slug}` &&
    r.result?.next_step
  );
  const seen = seenReviewKeys(agent);
  const reviewables = proposing.filter((r) => !seen.has(reviewKey(r.runId, r.roundsUsed)));

  if (reviewables.length === 0) {
    const summary = proposing.length > 0
      ? `Nothing new to review (${proposing.length} already-reviewed run(s) still awaiting Nick).`
      : "Nothing to review.";
    updateAgentRun(state.runId, { status: "done", summary, finished: true });
    markAgentHeartbeat(agent.id, agent.rotation_cursor, { touchHeartbeat });
    finishHeartbeat(agent, state, "done");
    return;
  }

  const reviewDir = reviewDirFor(agent, state.runId);
  mkdirSync(reviewDir, { recursive: true });
  state.cardsTotal = reviewables.length;
  pushLog(state, "info", `Review pass — ${reviewables.length} run(s) awaiting a decision.`);

  // ── Phase A: review ──
  const briefFile = `${reviewDir}/review-brief.json`;
  writeFileSync(briefFile, JSON.stringify({
    schema: 1,
    phase: "review",
    review_id: state.runId,
    out_path: `${reviewDir}/supervisor-review.json`,
    supervisor: { slug: agent.slug, name: agent.name },
    policy: {
      min_certitude: agent.min_certitude,
      auto_route: "opendia",
      reversible_only: true,
      max_approvals: agent.max_auto_approvals,
      shadow: !agent.autopilot,
    },
    reviewables: reviewables.map((r) => ({
      project_id: r.projectId,
      project: getProjectById(r.projectId),
      spark_run_id: r.runId,
      run_status: r.status,
      started_by: r.startedBy,
      rounds_used: r.roundsUsed,
      idle_wrap_at: r.idleWrapAt,
      result: r.result,
    })),
  }, null, 2));

  await spawnSupervisor(agent, state, reviewDir, { briefFile, resume: false });
  const verdicts = readVerdicts(`${reviewDir}/supervisor-review.json`, "review");

  const approved = [];   // {project_id, name, verdict, outcome?, redispatched?}
  const escalated = [];  // {project_id, name, reason, note, wouldApprove}
  let approvals = 0;
  const nameOf = (pid) => getProjectById(pid)?.name || `card ${pid}`;

  // Certitude travels into every recorded entry so the activity feed can
  // show what confidence each decision was made at.
  const certOf = (r) => {
    const pct = r?.result?.certitude?.pct;
    return Number.isInteger(pct) ? pct : null;
  };

  if (!verdicts) {
    // Fail closed: a review pass with no usable verdict file escalates everything.
    pushLog(state, "warn", "Review pass produced no usable verdict file — escalating all.");
    for (const r of reviewables) {
      escalated.push({ project_id: r.projectId, name: nameOf(r.projectId), certitude: certOf(r), reason: "no usable verdict", note: "", wouldApprove: false });
    }
  } else {
    // Highest certitude first, so the approval cap spends itself on the most
    // defensible work.
    const byPid = new Map(reviewables.map((r) => [Number(r.projectId), r]));
    verdicts.sort((a, b) =>
      (byPid.get(Number(b.project_id))?.result?.certitude?.pct || 0) -
      (byPid.get(Number(a.project_id))?.result?.certitude?.pct || 0));

    for (const v of verdicts) {
      const pid = Number(v.project_id);
      if (!byPid.has(pid)) continue;
      const certitude = certOf(byPid.get(pid));
      if (v.verdict === "hold") continue;
      if (Date.now() - state.startedAt > HEARTBEAT_MAX_MS - 5 * 60 * 1000) {
        escalated.push({ project_id: pid, name: nameOf(pid), certitude, reason: "ran out of window", note: v.escalation_note || "", wouldApprove: false });
        continue;
      }
      const g = guardrailCheck(agent, v, approvals);
      if (!g.ok) {
        escalated.push({
          project_id: pid, name: nameOf(pid), certitude,
          reason: g.reason, note: v.escalation_note || v.reason || "",
          wouldApprove: g.reason === "shadow mode" && v.verdict === "approve",
        });
        continue;
      }
      const res = await superviseDecide(pid, {
        intent: "do", model: SUPERVISED_ROUND_MODEL, decidedBy: `agent:${agent.slug}`,
      });
      if (!res.ok) {
        escalated.push({ project_id: pid, name: nameOf(pid), certitude, reason: res.error, note: v.reason || "", wouldApprove: false });
        continue;
      }
      approvals += 1;
      state.currentProject = { id: pid, name: nameOf(pid) };
      emit(state, "progress", publicLive(state));
      pushLog(state, "info", `Approved ${nameOf(pid)} — round running on ${SUPERVISED_ROUND_MODEL}.`);
      const settled = await waitForRunSettled(pid);
      const outcome = settled?.outcomes?.[settled.outcomes.length - 1] || null;
      approved.push({ project_id: pid, name: nameOf(pid), certitude, reason: v.reason || "", outcome, redispatched: false });
      state.cardsDone += 1;
      state.currentProject = null;
      emit(state, "progress", publicLive(state));
    }
  }

  // ── Phase B: QA on what actually ran ──
  if (approved.length > 0) {
    const qaFile = `${reviewDir}/qa-brief.json`;
    writeFileSync(qaFile, JSON.stringify({
      schema: 1,
      phase: "qa",
      review_id: state.runId,
      out_path: `${reviewDir}/supervisor-qa.json`,
      approved: approved.map((a) => {
        const run = getSparkRun(a.project_id);
        return {
          project_id: a.project_id,
          name: a.name,
          outcome: a.outcome,
          drafts: run?.drafts || [],
          new_next_step: run?.result?.next_step || null,
          card_next_step: getProjectById(a.project_id)?.next_step || null,
        };
      }),
    }, null, 2));

    pushLog(state, "info", `QA pass — verifying ${approved.length} completed round(s).`);
    await spawnSupervisor(agent, state, reviewDir, { briefFile: qaFile, resume: true });
    const qa = readVerdicts(`${reviewDir}/supervisor-qa.json`, "qa") || [];

    for (const q of qa) {
      const pid = Number(q.project_id);
      const a = approved.find((x) => x.project_id === pid);
      if (!a) continue;
      a.report_line = q.report_line || "";
      if (q.verdict === "accept") continue;
      if (q.verdict === "redispatch" && !a.redispatched && agent.autopilot) {
        const run = getSparkRun(pid);
        const step = run?.result?.next_step;
        if (run && run.status === "proposing" && step?.route === "opendia" && step.reversible === true) {
          a.redispatched = true;
          pushLog(state, "warn", `Redispatching ${a.name}: ${q.fix_note || "fix requested"}`);
          const res = await superviseDecide(pid, {
            intent: "do", note: q.fix_note || "", model: SUPERVISED_ROUND_MODEL,
            decidedBy: `agent:${agent.slug}`,
          });
          if (res.ok) {
            const settled = await waitForRunSettled(pid);
            a.outcome = settled?.outcomes?.[settled.outcomes.length - 1] || a.outcome;
          }
          continue;
        }
      }
      // Anything else — unknown verdict, second defect, undecidable run — escalates.
      escalated.push({ project_id: pid, name: a.name, certitude: a.certitude ?? null, reason: `QA: ${q.verdict}`, note: q.fix_note || q.report_line || "", wouldApprove: false });
    }
  }

  // ── Record + report ──
  const wouldApprove = escalated.filter((e) => e.wouldApprove).length;
  const finalStatus = "done";
  const shadowTag = agent.autopilot ? "" : `SHADOW — would have approved ${wouldApprove}. `;
  const summary =
    `${shadowTag}Reviewed ${reviewables.length}, approved ${approved.length}` +
    `${approved.filter((a) => a.redispatched).length ? ` (${approved.filter((a) => a.redispatched).length} redispatched)` : ""}, ` +
    `escalated ${escalated.length}.`;

  updateAgentRun(state.runId, {
    status: finalStatus,
    tokensUsed: state.tokens,
    costUsd: state.costUsd,
    summary,
    detail: JSON.stringify({
      reviewed: reviewables.length,
      approved,
      escalated,
      // The dedup ledger: what this pass looked at, keyed by run + round
      // count, so later heartbeats skip anything unchanged.
      reviewed_runs: reviewables.map((r) => ({
        spark_run_id: r.runId,
        rounds_used: r.roundsUsed || 0,
        project_id: r.projectId,
        shadow: !agent.autopilot,
      })),
    }),
    finished: true,
  });
  markAgentHeartbeat(agent.id, agent.rotation_cursor, { touchHeartbeat });

  const base = (process.env.DASHBOARD_PUBLIC_URL || "").replace(/\/$/, "");
  const link = (pid, name) => base ? `<${base}/?project=${pid}&tab=spark|${name}>` : name;
  const lines = [`${agent.name} — nightly review: ${summary}`];
  for (const a of approved) {
    lines.push(`✓ ${link(a.project_id, a.name)} — ${a.report_line || a.outcome?.summary || "completed"}`);
  }
  for (const e of escalated) {
    lines.push(`→ ${link(e.project_id, e.name)} — needs Nick: ${e.note || e.reason}${e.wouldApprove ? " [would approve]" : ""}`);
  }
  lines.push(`Tokens ${state.tokens.toLocaleString()} · $${state.costUsd.toFixed(2)}`);
  await notifyChat(agent.chat_webhook_url, lines.join("\n"));

  finishHeartbeat(agent, state, finalStatus, summary);
}

// ── tick ───────────────────────────────────────────────────────────────────

// Digest mode: one Chat message after the window closes, covering every run
// since the last digest. Fires on the first tick that finds the agent idle and
// outside its window with undigested runs; the stamp lands before the send so
// a slow webhook can never double-post.
function sendDigest(agent) {
  const runs = getAgentRunsSince(agent.id, agent.last_digest_at)
    .filter((r) => r.trigger !== "status");
  if (runs.length === 0) return;
  markAgentDigest(agent.id);

  let swept = 0, awaiting = 0;
  const cardLines = [];
  for (const run of runs) {
    let detail = [];
    try { detail = JSON.parse(run.detail || "[]"); } catch {}
    for (const d of detail) {
      if (!d.spark_run_id) continue;
      swept += 1;
      awaiting += d.awaiting || 0;
      cardLines.push({ id: d.project_id, name: d.name, route: d.route });
    }
  }
  const base = (process.env.DASHBOARD_PUBLIC_URL || "").replace(/\/$/, "");
  const links = cardLines.slice(0, 10).map((c) =>
    base ? `<${base}/?project=${c.id}&tab=spark|${c.name}>${c.route ? ` (${c.route})` : ""}` : c.name
  ).join(", ");
  const more = cardLines.length > 10 ? ` +${cardLines.length - 10} more` : "";
  notifyChat(agent.chat_webhook_url,
    `${agent.name} — window digest: ${swept} card(s) swept across ${runs.length} heartbeat(s), ` +
    `${awaiting} next step(s) awaiting a decision.` +
    (cardLines.length ? `\nReviewed: ${links}${more}` : "")
  ).catch(() => {});
}

function tick() {
  const checked = [];
  const started = [];
  const skipped = [];
  for (const agent of getAllAgents()) {
    checked.push(agent.slug);
    if (!agent.enabled) { skipped.push({ slug: agent.slug, reason: "disabled" }); continue; }
    if (live.has(agent.id)) { skipped.push({ slug: agent.slug, reason: "running" }); continue; }
    if (!inScheduleWindow(agent)) {
      // Supervisors send their own report per review pass — no digest.
      if (agent.chat_mode === "digest" && agent.role !== "supervisor") sendDigest(agent);
      skipped.push({ slug: agent.slug, reason: "off-schedule" });
      continue;
    }
    if (minutesSinceLastHeartbeat(agent) < agent.heartbeat_minutes) {
      skipped.push({ slug: agent.slug, reason: "not-due" });
      continue;
    }
    startHeartbeat(agent, "heartbeat");
    started.push(agent.slug);
  }
  return { checked: checked.length, started, skipped };
}

// ── status update ──────────────────────────────────────────────────────────

async function requestStatus(agent) {
  const runs = getAgentRuns(agent.id, 5);
  const projects = rosterFor(agent);
  const memory = readAgentFile(agent.slug, "memory.md").split("\n").slice(-20).join("\n");

  const fallback =
    `Idle since ${fmtET(agent.last_heartbeat_at) || "never run"}. ${projects.length} card(s) assigned; ` +
    `working ${agent.schedule_days} ${agent.schedule_start}–${agent.schedule_end} ET, ` +
    `every ${agent.heartbeat_minutes}m. Last heartbeat: ${runs[0]?.summary || "none yet"}.`;

  let text = fallback;
  try {
    text = await runClaude(
      `You are ${agent.name}, an OpenDia Agent. Write a short first-person status update ` +
      `(5 sentences max, plain text, no markdown) for your manager based on this data. ` +
      `Be concrete about what's pending and what's next.\n\n` +
      `Recent heartbeats:\n${runs.map((r) => `- ${r.started_at} [${r.status}] ${r.summary || ""}`).join("\n") || "none"}\n\n` +
      `Assigned cards:\n${projects.map((p) => `- ${p.name} [${p.status}] next: ${p.next_step || "?"}`).join("\n") || "none"}\n\n` +
      `Scratchpad tail:\n${memory}`,
      { model: "haiku", timeoutMs: 60_000 },
    ) || fallback;
  } catch (err) {
    console.error("agents: status model call failed, using fallback:", err.message);
  }

  const runId = randomUUID();
  insertAgentRun({ id: runId, agentId: agent.id, trigger: "status", status: "done", summary: text });
  updateAgentRun(runId, { finished: true });
  const state = live.get(agent.id);
  if (state) emit(state, "status", { text });
  return text;
}

// ── routes ─────────────────────────────────────────────────────────────────

function listRow(agent) {
  const projects = rosterFor(agent);
  const state = live.get(agent.id);
  const runs = getAgentRuns(agent.id, 1);
  return {
    ...agent,
    project_count: projects.length,
    pending_approvals: pendingApprovalsFor(projects),
    active: !!state,
    current_project: state?.currentProject || null,
    in_window: inScheduleWindow(agent),
    last_run: runs[0] || null,
  };
}

export function mountAgents(app) {
  const stale = interruptStaleAgentRuns();
  if (stale > 0) console.log(`agents: marked ${stale} orphaned heartbeat run(s) interrupted`);

  app.get("/api/agents", requireAdmin, (_req, res) => {
    try {
      res.json(getAllAgents().map(listRow));
    } catch (err) {
      console.error("GET /api/agents error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/agents", requireAdmin, (req, res) => {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    try {
      const agent = createAgent({ slug: slugify(name), name });
      scaffoldAgentFiles(agent);
      res.status(201).json(agent);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: "an agent with that slug already exists" });
      console.error("POST /api/agents error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/agents/:id", requireAdmin, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    const memoryMd = readAgentFile(agent.slug, "memory.md");
    res.json({
      ...listRow(agent),
      projects: rosterFor(agent),
      agent_md: readAgentFile(agent.slug, "agent.md"),
      memory_md: memoryMd,
      memory_lines: memoryMd ? memoryMd.split("\n").length : 0,
      runs: getAgentRuns(agent.id, 25),
      live: publicLive(live.get(agent.id)),
    });
  });

  app.patch("/api/agents/:id", requireAdmin, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    const fields = { ...req.body };
    if (fields.model !== undefined && !VALID_MODELS.has(fields.model)) {
      return res.status(400).json({ error: `model must be one of: ${[...VALID_MODELS].join(", ")}` });
    }
    if (fields.roster_mode !== undefined && !["static", "query"].includes(fields.roster_mode)) {
      return res.status(400).json({ error: "roster_mode must be static or query" });
    }
    if (fields.query_next_step !== undefined && !["any", "stale"].includes(fields.query_next_step)) {
      return res.status(400).json({ error: "query_next_step must be any or stale" });
    }
    if (fields.chat_mode !== undefined && !["per_heartbeat", "quiet", "digest"].includes(fields.chat_mode)) {
      return res.status(400).json({ error: "chat_mode must be per_heartbeat, quiet, or digest" });
    }
    if (fields.role !== undefined && !["scanner", "supervisor"].includes(fields.role)) {
      return res.status(400).json({ error: "role must be scanner or supervisor" });
    }
    if (fields.min_certitude !== undefined) {
      const n = Number(fields.min_certitude);
      if (!Number.isInteger(n) || n < 0 || n > 100) return res.status(400).json({ error: "min_certitude must be 0-100" });
      fields.min_certitude = n;
    }
    if (fields.max_auto_approvals !== undefined) {
      const n = Number(fields.max_auto_approvals);
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: "max_auto_approvals must be >= 0" });
      fields.max_auto_approvals = n;
    }
    if (fields.autopilot !== undefined) fields.autopilot = fields.autopilot ? 1 : 0;
    if (fields.enabled !== undefined) fields.enabled = fields.enabled ? 1 : 0;
    try {
      updateAgent(agent.id, fields);
      res.json(getAgentById(agent.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/agents/:id/files", requireAdmin, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    const dir = agentDir(agent.slug);
    mkdirSync(dir, { recursive: true });
    try {
      if (typeof req.body?.agent_md === "string") writeFileSync(`${dir}/agent.md`, req.body.agent_md);
      if (typeof req.body?.memory_md === "string") writeFileSync(`${dir}/memory.md`, req.body.memory_md);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/agents/:id/projects", requireAdmin, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    const projectId = Number(req.body?.project_id);
    if (!projectId || !getProjectById(projectId)) return res.status(400).json({ error: "valid project_id required" });
    assignAgentProject(agent.id, projectId);
    res.json({ projects: getAgentProjects(agent.id) });
  });

  app.delete("/api/agents/:id/projects/:projectId", requireAdmin, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    unassignAgentProject(agent.id, Number(req.params.projectId));
    res.json({ projects: getAgentProjects(agent.id) });
  });

  app.get("/api/agents/:id/runs", requireAdmin, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    res.json(getAgentRuns(agent.id, Math.min(200, Number(req.query.limit) || 50)));
  });

  app.post("/api/agents/:id/heartbeat", requireAdmin, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    if (live.has(agent.id)) return res.status(409).json({ error: "a heartbeat is already running for this agent" });
    // Manual runs bypass the schedule gate and the not-due check, never the
    // running/concurrency checks.
    const state = startHeartbeat(agent, "manual");
    res.status(202).json({ runId: state.runId });
  });

  app.post("/api/agents/:id/status-request", requireAdmin, async (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });
    try {
      res.json({ text: await requestStatus(agent) });
    } catch (err) {
      console.error("POST /api/agents/:id/status-request error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/agents/:id/stream", requireAdmin, (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const state = live.get(agent.id);
    if (!state) {
      res.write(`event: snapshot\ndata: ${JSON.stringify({ status: "idle" })}\n\n`);
      res.end();
      return;
    }

    res.write(`id: ${state.seq}\nevent: snapshot\ndata: ${JSON.stringify(publicLive(state))}\n\n`);
    state.subs.add(res);
    const ka = setInterval(() => {
      try { res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`); } catch {}
    }, KEEPALIVE_MS);
    req.on("close", () => {
      clearInterval(ka);
      state.subs.delete(res);
    });
  });

  app.post("/api/agents/tick", requireAdmin, (_req, res) => {
    try {
      res.json(tick());
    } catch (err) {
      console.error("POST /api/agents/tick error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
