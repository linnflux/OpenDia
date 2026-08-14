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
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";

import { requireAdmin } from "./auth.js";
import {
  getAllAgents, getAgentById, createAgent, updateAgent, markAgentHeartbeat,
  getAgentProjects, assignAgentProject, unassignAgentProject,
  insertAgentRun, updateAgentRun, getAgentRuns, interruptStaleAgentRuns,
  getProjectById,
} from "./db.js";
import { startScan, activeSparkCount, getSparkRun, SPARK_MAX_CONCURRENT } from "./spark.js";
import { etNow } from "./timerfile.js";
import { notifyChat } from "./chat_notify.js";
import { runClaude } from "./ai.js";

const HOME = process.env.HOME || "/home/linnflux";
const AGENTS_ROOT = `${HOME}/OpenDia/agents`;

const HEARTBEAT_MAX_MS = Number(process.env.AGENT_HEARTBEAT_MAX_MS || 45 * 60 * 1000);
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
  if (!days.includes(etDayOfWeek(now))) return false;
  const hhmm = `${now.HH}:${now.mm}`;
  return agent.schedule_start <= hhmm && hhmm < agent.schedule_end;
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
  const state = {
    runId,
    agentId: agent.id,
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
  const assigned = getAgentProjects(agent.id);
  const touchHeartbeat = state.trigger !== "manual";
  if (assigned.length === 0) {
    updateAgentRun(state.runId, { status: "done", summary: "No projects assigned.", finished: true });
    markAgentHeartbeat(agent.id, agent.rotation_cursor, { touchHeartbeat });
    finishHeartbeat(agent, state, "done");
    return;
  }

  // Rotate so a budget-exhausted heartbeat resumes where it left off.
  const cursor = agent.rotation_cursor % assigned.length;
  const cards = [...assigned.slice(cursor), ...assigned.slice(0, cursor)];
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

    const actions = sparkRun.result?.actions?.length || 0;
    details.push({
      project_id: card.id,
      name: card.name,
      spark_run_id: sparkRun.id,
      status: sparkRun.error ? "error" : sparkRun.status,
      tokens,
      cost_usd: sparkRun.costUsd || 0,
      next_step: sparkRun.result?.next_step || null,
      actions,
    });
    updateAgentRun(state.runId, {
      tokensUsed: state.tokens,
      costUsd: state.costUsd,
      detail: JSON.stringify(details),
    });
    pushLog(state, "info",
      `${card.name}: ${sparkRun.error ? "error" : "scanned"} — ${tokens} tokens, ${actions} proposal(s).`);
    state.currentProject = null;
    emit(state, "progress", publicLive(state));

    if (state.tokens >= agent.heartbeat_token_limit) {
      pushLog(state, "warn", `Token limit reached (${state.tokens}/${agent.heartbeat_token_limit}) — pausing until next heartbeat.`);
      finalStatus = "budget_exhausted";
      break;
    }
  }

  const proposals = details.reduce((n, d) => n + (d.actions || 0), 0);
  const summary =
    `Swept ${state.cardsDone}/${cards.length} card(s), ${proposals} proposal(s) pending` +
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
  markAgentHeartbeat(agent.id, (agent.rotation_cursor + ran) % assigned.length, { touchHeartbeat });

  if (proposals > 0 || finalStatus !== "done") {
    // Per-card deep links straight to the Spark tab, where approval lives.
    // Google Chat webhook text renders <url|label> as a link.
    const base = (process.env.DASHBOARD_PUBLIC_URL || "").replace(/\/$/, "");
    const cardLinks = base
      ? details
          .filter((d) => d.spark_run_id)
          .map((d) => `<${base}/?project=${d.project_id}&tab=spark|${d.name}>${d.actions ? ` (${d.actions})` : ""}`)
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

// ── tick ───────────────────────────────────────────────────────────────────

function tick() {
  const checked = [];
  const started = [];
  const skipped = [];
  for (const agent of getAllAgents()) {
    checked.push(agent.slug);
    if (!agent.enabled) { skipped.push({ slug: agent.slug, reason: "disabled" }); continue; }
    if (live.has(agent.id)) { skipped.push({ slug: agent.slug, reason: "running" }); continue; }
    if (!inScheduleWindow(agent)) { skipped.push({ slug: agent.slug, reason: "off-schedule" }); continue; }
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
  const projects = getAgentProjects(agent.id);
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
  const projects = getAgentProjects(agent.id);
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
      projects: getAgentProjects(agent.id),
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
