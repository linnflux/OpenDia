// Briefing — the admin morning view's backend.
//
// Generated content is never made on page load: three generators write dated
// artifacts under ~/OpenDia/briefing/YYYY-MM-DD/ and the view renders the
// latest with its age. The /hello brief reuses the operator log the skill
// already writes (a manual /hello in the operator session lands in the same
// file the cron run does). Supervisor check-ins and OD Recs gather their
// signals SERVER-side and hand a JSON blob to a tool-less runClaude — the
// model only reasons, so no sandbox is needed and a run is seconds, not
// minutes. Cron hits POST /api/briefing/generate at 06:30 ET daily
// (scripts/briefing-cron.sh); the view's per-section ↻ hits the same route.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { spawn, execFile } from "child_process";
import { requireAdmin } from "./auth.js";
import {
  listSupervisorCards, getOpenProjectsByCompany, getInboxItemsByProject,
  getWfHumanProjects, getStaleInProgressProjects, getAllProjects,
} from "./db.js";
import { gateForSession } from "./session_gate.js";
import { searchRecentEmails } from "./gmail.js";
import { runClaude } from "./ai.js";
import { listPlanrooms } from "./planroom_build.js";
import { listProposingRuns } from "./spark.js";

const HOME = process.env.HOME;
const BRIEFING_ROOT = resolve(HOME, "OpenDia", "briefing");
const OPERATOR_LOG_DIR = resolve(HOME, "OpenDia", "operator", "log");
const DEADLINE_CACHE = resolve(HOME, "OpenDia", "Time", ".deadline-alerts.json");
const CLAUDE_BIN = resolve(HOME, ".local", "bin", "claude");

const HELLO_BUDGET_USD = 1.5;
const HELLO_KILL_MS = 10 * 60 * 1000;
const SECTIONS = ["hello", "supervisors", "recs"];

const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const today = () => etDay.format(new Date());

// ── artifacts ────────────────────────────────────────────────────────────────

function dayDir(date) {
  const dir = resolve(BRIEFING_ROOT, date);
  mkdirSync(resolve(dir, "supervisors"), { recursive: true });
  return dir;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeMeta(date, section, fields) {
  const path = resolve(dayDir(date), "meta.json");
  const meta = readJson(path) || {};
  meta[section] = { ...(meta[section] || {}), ...fields };
  writeFileSync(path, JSON.stringify(meta, null, 2));
}

// The model returns prose-wrapped JSON more often than not; take the outer
// object and refuse the rest.
function parseModelJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON object in model output");
  return JSON.parse(m[0]);
}

// ── generators ───────────────────────────────────────────────────────────────

const inFlight = { hello: false, supervisors: false, recs: false };

// 1. /hello — the newsletter headless pattern + a budget cap it lacked. The
// skill writes ~/OpenDia/operator/log/<date>.md itself; that log is the
// artifact this view renders.
function generateHello(date) {
  if (inFlight.hello) return false;
  inFlight.hello = true;
  const started = Date.now();
  writeMeta(date, "hello", { started_at: new Date().toISOString(), error: null });

  const prompt = [
    "Run /hello with these adjustments for a headless morning run:",
    "- Skip Step 1 entirely (assume the operator context; ask nothing).",
    "- Run Steps 2 through 4 exactly as written: create/carry over the daily",
    `  operator log, do the parallel fetch, and write the full log file.`,
    "- SKIP Step 5 completely — no dispatch menu, no suggested-focus prompt,",
    "  no questions. End your run right after the log file is written.",
    "- Never send email or write to Notion; this run is read-and-summarize only",
    "  (the log file is the one artifact).",
  ].join("\n");

  const proc = spawn(CLAUDE_BIN, [
    "-p", prompt,
    "--model", "sonnet",
    "--permission-mode", "bypassPermissions",
    "--output-format", "json",
    "--max-budget-usd", String(HELLO_BUDGET_USD),
  ], { cwd: resolve(HOME, "OpenDia") });

  let stdout = "";
  proc.stdout.on("data", (d) => { stdout += d; });
  proc.stderr.on("data", () => {});
  const killer = setTimeout(() => proc.kill("SIGKILL"), HELLO_KILL_MS);
  proc.on("close", (code) => {
    clearTimeout(killer);
    inFlight.hello = false;
    let cost = null;
    try { cost = JSON.parse(stdout)?.total_cost_usd ?? null; } catch {}
    writeMeta(date, "hello", {
      generated_at: new Date().toISOString(),
      ms: Date.now() - started,
      cost_usd: cost,
      error: code === 0 ? null : `claude exited ${code}`,
    });
  });
  proc.on("error", (err) => {
    clearTimeout(killer);
    inFlight.hello = false;
    writeMeta(date, "hello", { error: err.message });
  });
  return true;
}

// 2. Supervisor check-ins — server gathers, model reasons (no tools).
async function gatherCompany(sup) {
  const cards = getOpenProjectsByCompany(sup.company_id);
  const sessions = [];
  for (const c of cards) {
    if (!c.tmux_session) continue;
    const g = gateForSession(c.tmux_session);
    sessions.push({
      card: c.id, session: c.tmux_session,
      state: g.ok === false && g.reason === "session-gone" ? "gone"
        : g.working ? "working"
        : g.reason === "dialog-open" ? "decision-waiting" : "idle",
    });
  }
  const inbox = cards.flatMap((c) =>
    (getInboxItemsByProject(c.id) || [])
      .filter((i) => !["done", "dismissed"].includes(i.status))
      .map((i) => ({ card: c.id, subject: i.subject, status: i.status, from: i.from_addr })));
  let emails = [];
  try {
    emails = (await searchRecentEmails(sup.company_name, { shortName: sup.company_short, days: 3 }))
      .slice(0, 6).map((e) => ({ subject: e.subject, from: e.from, date: e.date, snippet: (e.snippet || "").slice(0, 160) }));
  } catch {}
  return {
    company: sup.company_name,
    supervisor_card: { id: sup.id, name: sup.name },
    cards: cards.map((c) => ({ id: c.id, name: c.name, status: c.status, next_step: c.next_step, division: c.division })),
    sessions, inbox, recent_email: emails,
  };
}

async function generateSupervisors(date) {
  if (inFlight.supervisors) return false;
  inFlight.supervisors = true;
  const started = Date.now();
  writeMeta(date, "supervisors", { started_at: new Date().toISOString(), error: null });
  try {
    const roster = listSupervisorCards();
    const errors = [];
    for (const sup of roster) {
      try {
        const blob = await gatherCompany(sup);
        const prompt = [
          `You are the morning supervisor check-in for ${blob.company} at a web-services company.`,
          "Below is today's raw signal: open cards with next steps, live session",
          "states (working / idle / decision-waiting / gone), open inbox items,",
          "and recent client email. Judge whether anything needs the operator's",
          "attention TODAY. Dead sessions on active work, a decision-waiting",
          "session, client email nobody has answered, an overdue next_step —",
          "those are attention items. Quiet, parked, or on-track work is not.",
          "",
          "Return STRICT JSON only, no prose, exactly this shape:",
          '{ "status": "ok" | "attention", "summary": "one or two sentences",',
          '  "attention": [ { "item": "...", "why": "...", "card_id": 123 } ] }',
          "attention MUST be [] when status is ok. card_id is optional per item.",
          "",
          JSON.stringify(blob, null, 1),
        ].join("\n");
        const out = await runClaude(prompt, { model: "sonnet", timeoutMs: 180000 });
        const verdict = parseModelJson(out);
        writeFileSync(resolve(dayDir(date), "supervisors", `${sup.company_id}.json`), JSON.stringify({
          company: blob.company, company_id: sup.company_id,
          supervisor_card: blob.supervisor_card,
          generated_at: new Date().toISOString(),
          status: verdict.status === "attention" ? "attention" : "ok",
          summary: String(verdict.summary || "").slice(0, 400),
          attention: Array.isArray(verdict.attention) ? verdict.attention.slice(0, 6).map((a) => ({
            item: String(a.item || "").slice(0, 200),
            why: String(a.why || "").slice(0, 300),
            card_id: Number.isInteger(a.card_id) ? a.card_id : null,
          })) : [],
        }, null, 2));
      } catch (err) {
        errors.push(`${sup.company_name}: ${err.message}`);
      }
    }
    writeMeta(date, "supervisors", {
      generated_at: new Date().toISOString(),
      ms: Date.now() - started,
      companies: roster.length,
      error: errors.length ? errors.join(" | ").slice(0, 500) : null,
    });
  } finally {
    inFlight.supervisors = false;
  }
  return true;
}

// 3. OD Recs — the whole-board picture in one blob, one opinionated answer.
function yesterdayLedger() {
  const d = new Date(Date.now() - 86_400_000);
  const [y, m] = [etDay.format(d).slice(0, 4), etDay.format(d).slice(5, 7)];
  try {
    return readFileSync(resolve(HOME, "OpenDia", "Time", y, m, `${etDay.format(d)}.md`), "utf8").slice(0, 8000);
  } catch { return "(no ledger yesterday)"; }
}

async function generateRecs(date) {
  if (inFlight.recs) return false;
  inFlight.recs = true;
  const started = Date.now();
  writeMeta(date, "recs", { started_at: new Date().toISOString(), error: null });
  try {
    const projects = getAllProjects({ includeCompleted: false });
    const counts = {};
    for (const p of projects) counts[p.status] = (counts[p.status] || 0) + 1;
    const blob = {
      date,
      deadlines: readJson(DEADLINE_CACHE),
      waiting_on_human: getWfHumanProjects().map((p) => ({ id: p.id, name: p.name, company: p.company_name, next_step: p.next_step })),
      stale_in_progress: getStaleInProgressProjects(14).map((p) => ({ id: p.id, name: p.name, company: p.company_name, next_step: p.next_step, updated_at: p.updated_at })),
      spark_proposals_awaiting_decision: listProposingRuns(),
      planroom_wakeups_due: planroomWakeupsDue(),
      board_counts: counts,
      due_soon: projects
        .filter((p) => /^\d{4}-\d{2}-\d{2}/.test(p.next_step || "") && p.next_step.slice(0, 10) <= date)
        .map((p) => ({ id: p.id, name: p.name, company: p.company_name, next_step: p.next_step })).slice(0, 40),
      yesterday_ledger: yesterdayLedger(),
    };
    const prompt = [
      "You are OpenDia, a genuine partner in running this web-services company.",
      "Below is this morning's raw operational picture. Answer one question:",
      "what would you SCREAM at the operator about getting done right now?",
      "Pick THE fire — the single highest-leverage thing today — plus up to",
      "five ranked recommendations under it. Be specific and opinionated;",
      "name cards and companies; prefer revenue, client-facing promises, and",
      "unblocking stuck work over internal polish. Effort is a rough size:",
      '"minutes", "an hour", "half a day".',
      "",
      "Return STRICT JSON only, exactly this shape:",
      '{ "fire": { "title": "...", "why": "...", "first_move": "...", "card_id": 123 },',
      '  "recs": [ { "title": "...", "why": "...", "effort": "...", "card_id": 123 } ] }',
      "card_id optional everywhere.",
      "",
      JSON.stringify(blob, null, 1),
    ].join("\n");
    const out = await runClaude(prompt, { model: "sonnet", timeoutMs: 180000 });
    const recs = parseModelJson(out);
    writeFileSync(resolve(dayDir(date), "recs.json"), JSON.stringify({
      generated_at: new Date().toISOString(),
      fire: recs.fire || null,
      recs: Array.isArray(recs.recs) ? recs.recs.slice(0, 5) : [],
    }, null, 2));
    writeMeta(date, "recs", { generated_at: new Date().toISOString(), ms: Date.now() - started, error: null });
  } catch (err) {
    writeMeta(date, "recs", { error: err.message, ms: Date.now() - started });
  } finally {
    inFlight.recs = false;
  }
  return true;
}

// ── vitals (live, cheap, zero AI) ────────────────────────────────────────────

function planroomWakeupsDue() {
  const t = today();
  try {
    return listPlanrooms()
      .filter(({ plan }) => plan.status === "parked" && plan.parked?.until && plan.parked.until <= t)
      .map(({ cardId, plan }) => ({ card_id: cardId, until: plan.parked.until, title: plan.title || null }));
  } catch { return []; }
}

let hoursCache = { at: 0, value: null };
function monthHours() {
  if (Date.now() - hoursCache.at < 10 * 60 * 1000) return hoursCache.value;
  const script = resolve(HOME, "OpenDia", "scripts", "month_hours.py");
  const run = (args) => new Promise((res) => {
    execFile("python3", [script, ...args], { timeout: 8000 }, (err, out) => {
      if (err) return res(null);
      const od = out.match(/OpenDia:\s+([\d.]+)/)?.[1];
      const tg = out.match(/Toggl:\s+([\d.—-]+)/)?.[1];
      res({ opendia: od ? Number(od) : null, toggl: tg && tg !== "—" ? Number(tg) : null });
    });
  });
  return Promise.all([run([]), run(["Linnflux"])]).then(([billable, internal]) => {
    hoursCache = { at: Date.now(), value: { billable, internal } };
    return hoursCache.value;
  });
}

// ── routes ───────────────────────────────────────────────────────────────────

export function registerBriefingRoutes(app) {
  app.get("/api/briefing", async (_req, res) => {
    try {
      // Serve today's artifacts, or the latest morning we have.
      let date = today();
      if (!existsSync(resolve(BRIEFING_ROOT, date))) {
        try {
          const dates = readdirSync(BRIEFING_ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
          if (dates.length) date = dates[dates.length - 1];
        } catch {}
      }
      const dir = resolve(BRIEFING_ROOT, date);
      const meta = readJson(resolve(dir, "meta.json")) || {};

      // The /hello artifact is the operator log for the SERVED date — a manual
      // /hello run in the operator session shows up here too.
      let hello = null;
      const logPath = resolve(OPERATOR_LOG_DIR, `${date}.md`);
      if (existsSync(logPath)) hello = readFileSync(logPath, "utf8").slice(0, 60_000);

      let supervisors = [];
      try {
        supervisors = readdirSync(resolve(dir, "supervisors"))
          .filter((f) => f.endsWith(".json"))
          .map((f) => readJson(resolve(dir, "supervisors", f)))
          .filter(Boolean)
          .sort((a, b) => (a.status === "attention" ? 0 : 1) - (b.status === "attention" ? 0 : 1)
            || String(a.company).localeCompare(String(b.company)));
      } catch {}

      res.json({
        date, meta,
        generating: { ...inFlight },
        hello,
        supervisors,
        roster: listSupervisorCards().map((s) => ({ company: s.company_name, card_id: s.id })),
        recs: readJson(resolve(dir, "recs.json")),
        vitals: {
          hours: await monthHours(),
          spark_proposals: listProposingRuns(),
          planroom_wakeups: planroomWakeupsDue(),
        },
      });
    } catch (err) {
      console.error("GET /api/briefing error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/briefing/generate", requireAdmin, (req, res) => {
    const section = String(req.query.section || "all");
    const wanted = section === "all" ? SECTIONS : [section];
    if (!wanted.every((s) => SECTIONS.includes(s))) {
      return res.status(400).json({ error: `unknown section: ${section}` });
    }
    const date = today();
    const started = [];
    for (const s of wanted) {
      // Check the flag HERE: the async generators return Promises (always
      // truthy), but each sets its inFlight flag synchronously before its
      // first await, so this check-then-fire has no gap.
      if (inFlight[s]) continue;
      const fn = s === "hello" ? generateHello : s === "supervisors" ? generateSupervisors : generateRecs;
      fn(date);
      started.push(s);
    }
    res.status(202).json({ date, started, skipped: wanted.filter((s) => !started.includes(s)) });
  });
}
