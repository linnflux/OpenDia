import http from "http";
import express from "express";
import { resolve, dirname, sep } from "path";
import { fileURLToPath } from "url";
import { PORT, BILLING_MASTER_SHEET_ID, confValue } from "./config.js";
import { mountTerminal } from "./terminal.js";
import { mountSpark } from "./spark.js";
import { registerRunroomRoutes } from "./runrooms.js";
import { registerPlanroomRoutes } from "./planrooms.js";
import { registerMailroomRoutes } from "./mailroom.js";
import { mountAgents } from "./agents.js";
import { requireLinnfluxUser, requireAdmin } from "./auth.js";
import { getAllProjects, updateProject, getProjectById, getProjectByTmuxSession, reorderProjects, matchProject, matchProjectCandidates, createProject, getAllInboxItems, updateInboxItem, deleteInboxItem, ensureInboxTable, getInboxItemById, ensureClientAliasesTable, getAllClientAliases, insertClientAlias, getInboxItemsByProject, ensureProjectForInbox, getProcessedGmailIds, moveProjectToTop, getStaleInProgressProjects, getAllCompanies, getWfHumanProjects, getOpenInboxCount, getRecentInbox, getProjectsByNotionIds, ensureProjectsColumns, ensureAgentsTables } from "./db.js";
import { spawn, execFile } from "child_process";
import { timingSafeEqual, randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { getTimerEntriesForProject, getActiveTimers, getAllTimerEntries, getWeekDetail, currentWeekKey } from "./timers.js";
import { fetchNotionPage, fetchNotionTitle, appendToggleBlocks, searchNotionForProject, appendTimerLog, getTimerMarkers, updateNotionTaskStatus, updateNotionTaskDueDate } from "./notion.js";
import { searchRecentEmails, listPrimaryInboxTop } from "./gmail.js";
import { readDeadlineCache, removeFromDeadlineCache, refreshDeadlineCache, bumpDeadlineInCache, getCachedDeadlineRow } from "./deadlines.js";
import { readSweepCache, runSweep } from "./sweep.js";
import { analyzeReview } from "./ai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "1mb" }));

// Git refs and repo paths reach git as argv (never a shell), but keep them
// boring anyway: no option-injection, no traversal, no shell metacharacters.
function isSafeGitRef(ref) {
  return typeof ref === "string"
    && ref.length > 0 && ref.length <= 200
    && /^[A-Za-z0-9._\/-]+$/.test(ref)
    && !ref.startsWith("-")
    && !ref.includes("..");
}

function isSafeRepoPath(p) {
  return typeof p === "string"
    && p.length > 0 && p.length <= 200
    && /^[A-Za-z0-9._\/-]+$/.test(p)
    && !p.startsWith("-")
    && !p.startsWith("/")
    && !p.split("/").includes("..");
}

// Dashboard card status → Notion task Status select value. "ice" has no Notion
// equivalent and deliberately maps to nothing (leaves the task alone).
const NOTION_STATUS_BY_CARD_STATUS = {
  in_progress: "In Progress",
  wfhuman: "WFR",
  completed: "Completed",
};

// Push a card's status through to its linked Notion task, fire-and-forget.
// Best-effort: a Notion hiccup must never throw into the caller.
function pushNotionStatus(project, cardStatus) {
  const notionStatus = NOTION_STATUS_BY_CARD_STATUS[cardStatus];
  if (!project?.notion_id || !notionStatus) return;
  setImmediate(async () => {
    try {
      const ok = await updateNotionTaskStatus(project.notion_id, notionStatus);
      if (!ok) console.warn(`notion status sync returned false for project ${project.id}`);
    } catch (err) {
      console.error(`notion status sync failed for project ${project.id}:`, err.message);
    }
  });
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function runGit(args, cwd) {
  return new Promise((res) => {
    execFile("git", args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      res({ code: err ? (err.code ?? 1) : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

const DEFAULT_THEME_DIR = resolve(__dirname, "..", "themes");

app.get("/api/theme", (req, res) => {
  const name = req.query.name || "dark";
  if (!/^[a-z0-9-]+$/.test(name)) return res.status(400).json({ error: "invalid theme name" });
  const themePath = process.env.OPENDIA_THEME || resolve(DEFAULT_THEME_DIR, `${name}.json`);
  try {
    res.json(JSON.parse(readFileSync(themePath, "utf8")));
  } catch {
    res.status(404).json({ error: "theme not found" });
  }
});

app.get("/api/themes", (req, res) => {
  try {
    const dir = DEFAULT_THEME_DIR;
    const themes = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const data = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
          return {
            name: f.replace(".json", ""),
            label: data.meta?.name || f.replace(".json", ""),
            bg: data.colors?.["bg-body"] || "#000",
            preview: {
              bg:      data.colors?.["bg-body"]    || "#000",
              surface: data.colors?.["bg-surface"] || "#111",
              accent:  data.colors?.["accent"]     || "#3b82f6",
              text:    data.colors?.["text-primary"] || "#fff",
              border:  data.colors?.["border"]     || "#333",
            },
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.label.localeCompare(b.label));
    res.json(themes);
  } catch {
    res.status(500).json({ error: "could not list themes" });
  }
});

// ── Google Calendar push webhook ─────────────────────────────────────────
// Public route (mounted BEFORE the Tailscale auth middleware — Google is the
// caller). Validates the channel token from the local calendar config, then
// triggers a coalesced calendar_sync.py run so a drag in Google Calendar
// reaches Notion within seconds. Exposed publicly via Tailscale Funnel on
// this one path only.
const CAL_CONFIG_PATH = resolve(process.env.HOME, "OpenDia", ".opendia-calendar.json");
const calSync = { child: null, timer: null, rerun: false };

function runCalendarSync() {
  if (calSync.child) { calSync.rerun = true; return; }
  calSync.child = spawn(`${process.env.HOME}/OpenDia/scripts/calendar_sync.py`, [], {
    env: { ...process.env },
    stdio: "ignore",
  });
  calSync.child.on("exit", () => {
    calSync.child = null;
    if (calSync.rerun) {
      calSync.rerun = false;
      scheduleCalendarSync();
    }
  });
  calSync.child.on("error", () => { calSync.child = null; });
}

function scheduleCalendarSync(delayMs = 2000) {
  if (calSync.timer) clearTimeout(calSync.timer);
  calSync.timer = setTimeout(() => { calSync.timer = null; runCalendarSync(); }, delayMs);
}

app.post("/api/calendar/webhook", (req, res) => {
  let expected = null;
  try {
    expected = JSON.parse(readFileSync(CAL_CONFIG_PATH, "utf8")).webhook_token || null;
  } catch {}
  const got = req.get("x-goog-channel-token") || "";
  if (!expected || !timingSafeEqualStr(got, expected)) {
    console.warn("calendar webhook: rejected (bad token)");
    return res.status(403).end();
  }
  const state = req.get("x-goog-resource-state") || "?";
  console.log(`calendar webhook: ${state}`);
  res.status(200).end();
  // Google sends state=sync on channel creation; a run is harmless either way
  scheduleCalendarSync();
});

app.use(requireLinnfluxUser);
app.get("/api/me", (req, res) => res.json(req.user));

// The dashboard deploys many times a day; a tab left open keeps its old
// bundle and silently misses new features (observed: the plan-approval panel
// shipped mid-evening and an open room tab never rendered it). The version is
// the built bundle's hashed filename, read once at boot — the client compares
// it to its own script tag and offers a reload when they diverge.
let bundleVersion = null;
try {
  const html = readFileSync(resolve(__dirname, "..", "client", "dist", "index.html"), "utf8");
  bundleVersion = (html.match(/\/assets\/(index-[\w-]+\.js)/) || [])[1] || null;
} catch {}
app.get("/api/version", (_req, res) => res.json({ bundle: bundleVersion }));

// API routes
app.get("/api/projects", (req, res) => {
  try {
    const includeCompleted = req.query.include_completed === "true";
    let projects = getAllProjects({ includeCompleted });
    // Operator command-deck card is admin-only
    if (!req.user?.is_admin) projects = projects.filter((p) => p.tmux_session !== "operator");
    // ?tmux_session=NAME — exact-match filter so CLI commands (/od-go, /hello,
    // /dispatch) can resolve a session to its card without pulling the full list.
    if (req.query.tmux_session) {
      projects = projects.filter((p) => p.tmux_session === req.query.tmux_session);
    }
    res.json(projects);
  } catch (err) {
    console.error("GET /api/projects error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects", (req, res) => {
  try {
    const { name, companyName, divisionName, status, notionId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const project = createProject({ name, companyName, divisionName, status, notionId });
    res.status(201).json(project);
  } catch (err) {
    console.error("POST /api/projects error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/projects/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const fields = req.body;
    if (!fields || Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "No fields provided" });
    }

    if (fields.status !== undefined) {
      moveProjectToTop(id, fields.status);
      const { status: _s, ...rest } = fields;
      if (Object.keys(rest).length > 0) {
        const updated = updateProject(id, rest);
        if (!updated) return res.status(404).json({ error: "project not found" });
      }
    } else {
      const updated = updateProject(id, fields);
      if (!updated) return res.status(404).json({ error: "project not found" });
    }

    // next_step (event date/text) and status (adds/removes next_step events)
    // affect the OpenDia calendar — sync now instead of waiting for cron
    if (fields.next_step !== undefined || fields.status !== undefined) {
      scheduleCalendarSync();
    }

    // Card status is one half of "is this done"; the linked Notion task is the
    // other. They used to drift forever — moving a card to Completed left the
    // Notion task open, so nothing ever actually closed. Push it through,
    // best-effort (a Notion hiccup must not fail the request).
    if (fields.status !== undefined) {
      pushNotionStatus(getProjectById(id), fields.status);
    }

    // Echo the fresh row: getProjectById re-reads SQLite, so this is a true
    // read-after-write — the Mailroom card gate compares it to the intended
    // value. Existing callers ignore the body; non-breaking.
    res.json({ ok: true, project: getProjectById(id) });
  } catch (err) {
    console.error("PATCH /api/projects/:id error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/projects/reorder", (req, res) => {
  try {
    const { status, ids } = req.body;
    if (!status || !Array.isArray(ids)) {
      return res.status(400).json({ error: "status and ids[] required" });
    }
    reorderProjects(status, ids);
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/projects/reorder error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/projects/match", (req, res) => {
  try {
    const { client, division, task } = req.query;
    if (!client && !division && !task) {
      return res.status(400).json({ error: "At least one of client, division, or task required" });
    }
    const project = matchProject(client, division, task);
    if (!project) {
      return res.status(404).json({ error: "No matching project found" });
    }
    res.json(project);
  } catch (err) {
    console.error("GET /api/projects/match error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/projects/match-candidates", (req, res) => {
  try {
    const { client, division, task } = req.query;
    const limit = parseInt(req.query.limit || "3", 10);
    const candidates = matchProjectCandidates(client, division, task, limit);
    res.json(candidates.map(({ id, name, status, company_name, company_short, division: div, score }) => ({
      id, name, status, company_name, company_short, division: div, score,
    })));
  } catch (err) {
    console.error("GET /api/projects/match-candidates error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/projects/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const project = getProjectById(id);
    if (!project) return res.status(404).json({ error: "not found" });
    if (project.tmux_session === "operator" && !req.user?.is_admin) {
      return res.status(404).json({ error: "not found" });
    }
    res.json(project);
  } catch (err) {
    console.error("GET /api/projects/:id error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Review a card against fresh evidence (Notion, new emails, recent timers).
// Returns PROPOSALS only — nothing is applied until the operator clicks Apply
// in the modal. The one exception is notion_id auto-discovery (safe,
// idempotent), which is reported as linked_notion.
app.post("/api/projects/:id/review", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const project = getProjectById(id);
    if (!project) {
      return res.status(404).json({ error: "project not found" });
    }

    let linkedNotion = false;
    if (!project.notion_id) {
      const discovered = await searchNotionForProject(project.name, project.company_name);
      if (discovered) {
        updateProject(id, { notion_id: discovered });
        project.notion_id = discovered;
        linkedNotion = true;
      }
    }

    let notion = null;
    if (project.notion_id) {
      notion = await fetchNotionPage(project.notion_id);
    }

    let timers = [];
    try {
      timers = await getTimerEntriesForProject(project, 3);
    } catch (err) {
      console.error("Timer lookup error:", err.message);
    }

    // Email lookback scales to the card's quiet period: cover everything since
    // the last work session (+1 week buffer), clamped to 7-60 days. A card
    // untouched for a month gets a month of email; an active card stays cheap.
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
      console.error("Gmail search error:", err.message);
    }
    // Only surface emails not already ingested as inbox items
    const processed = getProcessedGmailIds();
    const newEmails = emails.filter((e) => !processed.has(e.id));

    let analysis = null;
    if (newEmails.length > 0 || notion || timers.length > 0) {
      try {
        analysis = await analyzeReview({ project, emails: newEmails, notion, timers });
      } catch (err) {
        console.error("AI review error:", err.message);
      }
    }

    res.json({
      summary: analysis?.summary || null,
      proposals: {
        next_step: analysis?.next_step || null,
        status: analysis?.status || null,
      },
      change_requests: analysis?.change_requests || [],
      new_emails: newEmails,
      linked_notion: linkedNotion,
      notion_title: notion?.title || null,
      email_lookback_days: lookbackDays,
    });
  } catch (err) {
    console.error("POST /api/projects/:id/review error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Apply target for a reviewed change request: append it to the linked Notion
// task as a toggle block. Explicit-click only — never called automatically.
app.post("/api/projects/:id/apply-change-request", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const project = getProjectById(id);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!project.notion_id) return res.status(400).json({ error: "no Notion task linked" });
    const { summary, detail } = req.body || {};
    if (!summary) return res.status(400).json({ error: "summary is required" });
    await appendToggleBlocks(project.notion_id, [{ summary, detail: detail || "" }]);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/projects/:id/apply-change-request error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/timers/active", async (req, res) => {
  try {
    const timers = await getActiveTimers();
    if (req.query.detail === "full") {
      const now = Date.now();
      return res.json(timers.map(t => ({
        ...t,
        elapsed_seconds: t.start ? Math.floor((now - new Date(t.start).getTime()) / 1000) : null,
      })));
    }
    const projectIds = new Set();
    for (const timer of timers) {
      const project = matchProject(timer.client, timer.division, timer.task, timer.project);
      if (project) projectIds.add(project.id);
    }
    res.json([...projectIds]);
  } catch (err) {
    console.error("GET /api/timers/active error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Log a single completed timer entry to the project's Notion task as a toggle.
// Silently skips if the project has no notion_id linked.
app.post("/api/projects/:id/log-timer", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const project = getProjectById(id);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!project.notion_id) return res.json({ logged: false, skipped: "no_notion_id" });

    const entry = req.body;
    if (!entry?.start) return res.status(400).json({ error: "start required" });

    const result = await appendTimerLog(project.notion_id, entry);
    res.json(result);
  } catch (err) {
    console.error("POST /api/projects/:id/log-timer error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Scan every daily .md file and back-fill Notion toggle blocks for any
// completed entry whose matching project has a notion_id and isn't already
// logged (dedupe by start-time marker in the toggle title).
app.post("/api/timers/backfill", async (_req, res) => {
  try {
    const entries = await getAllTimerEntries();
    let logged = 0;
    let skippedAlreadyLogged = 0;
    let skippedNoProject = 0;
    let skippedNoNotion = 0;
    const errors = [];
    const markerCache = new Map();

    // Sort ascending so Notion receives entries in chronological order.
    entries.sort((a, b) => (a.start || "").localeCompare(b.start || ""));

    for (const entry of entries) {
      const project = matchProject(
        entry.client,
        entry.division,
        entry.task,
        entry.project
      );
      if (!project) {
        skippedNoProject++;
        continue;
      }
      if (!project.notion_id) {
        skippedNoNotion++;
        continue;
      }

      if (!markerCache.has(project.notion_id)) {
        markerCache.set(
          project.notion_id,
          await getTimerMarkers(project.notion_id)
        );
      }
      const markers = markerCache.get(project.notion_id);
      const marker = entry.start.replace("T", " ");
      if (markers.has(marker)) {
        skippedAlreadyLogged++;
        continue;
      }

      const result = await appendTimerLog(project.notion_id, entry);
      if (result.logged) {
        logged++;
        markers.add(marker);
        // Throttle to stay under Notion's ~3 req/sec rate limit
        await new Promise((r) => setTimeout(r, 400));
      } else {
        errors.push({ start: entry.start, project: project.id, reason: result.reason });
      }
    }

    res.json({
      logged,
      skippedAlreadyLogged,
      skippedNoProject,
      skippedNoNotion,
      errors,
      totalScanned: entries.length,
    });
  } catch (err) {
    console.error("POST /api/timers/backfill error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Today / heads-up endpoint ─────────────────────────────────────────────────

app.get("/api/today", async (req, res) => {
  try {
    const now = Date.now();
    const [timersResult, gmailResult] = await Promise.allSettled([
      getActiveTimers(),
      listPrimaryInboxTop(5),
    ]);

    const timers = timersResult.status === "fulfilled" ? timersResult.value : [];
    const gmailMessages = gmailResult.status === "fulfilled" ? gmailResult.value : null;

    const wfhumanItems = getWfHumanProjects();

    const deadlines = readDeadlineCache();
    if (!deadlines.error) {
      const allIds = [
        ...(deadlines.overdue || []),
        ...(deadlines.imminent || []),
      ].map((t) => t.id).filter(Boolean);
      const projectMap = getProjectsByNotionIds(allIds);
      const enrich = (t) => {
        const p = projectMap.get(t.id);
        return p
          ? { ...t, company_name: p.company_name, company_short: p.company_short, division: p.division, project_id: p.project_id }
          : t;
      };
      deadlines.overdue = (deadlines.overdue || []).map(enrich);
      deadlines.imminent = (deadlines.imminent || []).map(enrich);
    }

    res.json({
      deadlines,
      wfhuman: { count: wfhumanItems.length, items: wfhumanItems },
      stale: getStaleInProgressProjects(14),
      active_timers: timers.map(t => ({
        ...t,
        elapsed_seconds: t.start ? Math.floor((now - new Date(t.start).getTime()) / 1000) : null,
      })),
      inbox: { open_count: getOpenInboxCount(), recent: getRecentInbox(5) },
      gmail: gmailMessages === null
        ? { error: gmailResult.reason?.message || "unavailable", messages: [] }
        : { messages: gmailMessages },
    });
  } catch (err) {
    console.error("GET /api/today error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/deadlines/refresh", async (_req, res) => {
  try {
    const data = await refreshDeadlineCache();
    res.json({ ok: true, overdue: data.overdue?.length || 0, imminent: data.imminent?.length || 0, generated: data.generated });
  } catch (err) {
    console.error("deadline refresh error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/deadlines/:notionId/bump", async (req, res) => {
  const { notionId } = req.params;
  const weeks = Number(req.body?.weeks) || 1;
  const dates = bumpDeadlineInCache(notionId, weeks);
  if (!dates) return res.status(404).json({ error: "not in deadline cache" });

  res.json({ ok: true, due_start: dates.start, due_end: dates.end });

  setImmediate(async () => {
    const current = getCachedDeadlineRow(notionId);
    if (!current?.due_start) return;
    try {
      await updateNotionTaskDueDate(notionId, { start: current.due_start, end: current.due_end });
      // Reflect the new due date on the OpenDia calendar immediately
      scheduleCalendarSync();
    } catch (err) {
      console.error(`Notion date bump failed for ${notionId}:`, err.message);
    }
  });
});

app.patch("/api/deadlines/:notionId/status", async (req, res) => {
  const { notionId } = req.params;
  const { status } = req.body || {};
  const ALLOWED = new Set(["Completed", "Reference"]);
  if (!ALLOWED.has(status)) {
    return res.status(400).json({ error: "status must be Completed or Reference" });
  }
  const ok = await updateNotionTaskStatus(notionId, status);
  if (!ok) return res.status(502).json({ error: "Notion update failed" });
  removeFromDeadlineCache(notionId);
  // Completed/Reference tasks lose their future calendar events — sync now
  scheduleCalendarSync();
  res.json({ ok: true, notionId, status });
});

// ── Analytics endpoints ───────────────────────────────────────────────────────

app.get("/api/analytics/week", async (req, res) => {
  try {
    const data = await getWeekDetail({ week: req.query.week });
    res.json(data);
  } catch (err) {
    console.error("GET /api/analytics/week error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/analytics/stale", (req, res) => {
  try {
    const days = parseInt(req.query.days || "14", 10);
    res.json(getStaleInProgressProjects(days));
  } catch (err) {
    console.error("GET /api/analytics/stale error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Billing endpoints (admin-only) ───────────────────────────────────────────

function lastMonthYYYYMM() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── Rooms (admin) ─────────────────────────────────────────────────
// The rooms daemon's own API answers loopback only (it reveals filesystem
// paths); admins reach it through this proxy so the gate stays in auth.js.
const ROOMS_API = `http://127.0.0.1:${confValue("ROOMS_PORT", "9099")}/api/rooms`;

app.get("/api/rooms", requireAdmin, async (_req, res) => {
  try {
    const r = await fetch(ROOMS_API);
    res.status(r.status).json(await r.json());
  } catch {
    res.status(502).json({ error: "rooms daemon unreachable" });
  }
});

app.delete("/api/rooms/:id", requireAdmin, async (req, res) => {
  if (!/^[A-Za-z0-9_-]+$/.test(req.params.id)) {
    return res.status(400).json({ error: "bad id" });
  }
  try {
    const r = await fetch(`${ROOMS_API}/${req.params.id}`, { method: "DELETE" });
    res.status(r.status).json(await r.json());
  } catch {
    res.status(502).json({ error: "rooms daemon unreachable" });
  }
});

app.get("/api/billing/preview", requireAdmin, (req, res) => {
  const month = req.query.month || lastMonthYYYYMM();
  const script = resolve(process.env.HOME, "OpenDia", "scripts", "monthly_billing.py");
  const proc = spawn("python3", [script, "--month", month, "--json"]);
  let out = "", err = "";
  proc.stdout.on("data", d => { out += d; });
  proc.stderr.on("data", d => { err += d; });
  proc.on("close", code => {
    if (code !== 0) {
      console.error("billing preview error:", err);
      return res.status(500).json({ error: err || "script failed" });
    }
    try {
      res.json(JSON.parse(out));
    } catch {
      res.status(500).json({ error: "failed to parse billing output" });
    }
  });
});

app.post("/api/billing/push", requireAdmin, (req, res) => {
  const month = (req.body && req.body.month) || lastMonthYYYYMM();
  if (!/^\d{4}-\d{2}$/.test(month))
    return res.status(400).json({ error: "invalid month format (expected YYYY-MM)" });
  const script = resolve(process.env.HOME, "OpenDia", "scripts", "monthly_billing.py");
  const proc = spawn("python3", [script, "--month", month, "--write-sheet"]);
  let out = "", err = "";
  proc.stdout.on("data", d => { out += d; });
  proc.stderr.on("data", d => { err += d; });
  proc.on("close", code => {
    if (code !== 0) {
      console.error("billing push error:", err);
      return res.status(500).json({ error: err.trim() || "script failed" });
    }
    const rowMatch = out.match(/Wrote (\d+) rows/);
    res.json({
      ok: true,
      month,
      rows: rowMatch ? parseInt(rowMatch[1], 10) : null,
      sheet_url: BILLING_MASTER_SHEET_ID
        ? `https://docs.google.com/spreadsheets/d/${BILLING_MASTER_SHEET_ID}/edit#gid=0`
        : null,
      stdout: out.trim(),
    });
  });
});

const TIME_DIR = resolve(process.env.HOME, "OpenDia", "Time");
const ENTRY_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

app.patch("/api/billing/entry", requireAdmin, (req, res) => {
  const { start, billable } = req.body || {};
  if (!ENTRY_START_RE.test(start || ""))
    return res.status(400).json({ error: "invalid start (expected YYYY-MM-DDTHH:MM)" });
  if (typeof billable !== "boolean")
    return res.status(400).json({ error: "billable must be a boolean" });

  const [date] = start.split("T");
  const [yyyy, mm] = date.split("-");
  const dailyFile = resolve(TIME_DIR, yyyy, mm, `${date}.md`);
  if (!existsSync(dailyFile))
    return res.status(404).json({ error: "daily file not found" });

  const original = readFileSync(dailyFile, "utf8");
  const marker = `<!-- entry:${start} -->`;
  const idx = original.indexOf(marker);
  if (idx === -1)
    return res.status(404).json({ error: "entry not found in daily file" });

  // Find the end of this entry block (next standalone ---)
  const after = original.slice(idx);
  const blockEndRel = after.search(/\n---\s*$/m);
  if (blockEndRel === -1)
    return res.status(500).json({ error: "could not locate end of entry block" });

  const block = after.slice(0, blockEndRel);
  const newBlock = block.replace(/^billable:\s*(true|false)\s*$/m, `billable: ${billable}`);
  if (newBlock === block)
    return res.status(500).json({ error: "billable line not found in entry" });

  const updated = original.slice(0, idx) + newBlock + after.slice(blockEndRel);
  writeFileSync(dailyFile, updated, "utf8");
  res.json({ ok: true, start, billable });
});

// ── Newsletter endpoints (admin-only) ─────────────────────────────────────────

const NEWSLETTER_DIR = resolve(process.env.HOME, "OpenDia", "newsletters");
const NEWSLETTER_NAME_RE = /^newsletter-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.md$/;

function safeNewsletterPath(name) {
  if (typeof name !== "string" || !NEWSLETTER_NAME_RE.test(name))
    throw new Error("invalid newsletter name");
  return resolve(NEWSLETTER_DIR, name);
}

app.get("/api/newsletter/list", requireAdmin, (_req, res) => {
  if (!existsSync(NEWSLETTER_DIR)) return res.json([]);
  const files = readdirSync(NEWSLETTER_DIR)
    .filter(n => NEWSLETTER_NAME_RE.test(n))
    .map(n => {
      const st = statSync(resolve(NEWSLETTER_DIR, n));
      const m = n.match(/^newsletter-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})\.md$/);
      return { name: n, from: m[1], to: m[2], mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.get("/api/newsletter/file", requireAdmin, (req, res) => {
  try {
    const path = safeNewsletterPath(req.query.name);
    if (!existsSync(path)) return res.status(404).json({ error: "not found" });
    res.json({ name: req.query.name, content: readFileSync(path, "utf8") });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put("/api/newsletter/file", requireAdmin, (req, res) => {
  try {
    const { name, content } = req.body;
    const path = safeNewsletterPath(name);
    writeFileSync(path, content ?? "", "utf8");
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/newsletter/generate", requireAdmin, (req, res) => {
  const { from, to, notes } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return res.status(400).json({ error: "invalid date format" });
  if (from > to)
    return res.status(400).json({ error: "from must be on or before to" });

  const targetName = `newsletter-${from}-to-${to}.md`;
  const targetPath = resolve(NEWSLETTER_DIR, targetName);

  const notesLine = notes && notes.trim()
    ? `\nIncorporate these user-provided notes during composition:\n${notes.trim()}`
    : "";
  const prompt = `Run /newsletter ${from} ${to}.\n\nThe user invoked this from the OpenDia dashboard and has already confirmed the date range — skip Step 2 (AskUserQuestion) and proceed directly to Step 3.${notesLine}`;

  const claudeBin = resolve(process.env.HOME, ".local", "bin", "claude");
  // Pinned 2026-08-12: see the same note in sweep.js — bypassPermissions never
  // reaches plan mode, so an unpinned run inherits the user-level model key.
  const proc = spawn(claudeBin, [
    "-p", prompt,
    "--model", "sonnet",
    "--permission-mode", "bypassPermissions",
    "--output-format", "json",
  ], { cwd: resolve(process.env.HOME, "OpenDia") });

  let stderr = "";
  proc.stderr.on("data", d => { stderr += d; });
  const killTimer = setTimeout(() => {
    proc.kill("SIGKILL");
    if (!res.headersSent) res.status(504).json({ error: "newsletter generation timed out after 10m" });
  }, 600000);
  proc.on("error", err => {
    clearTimeout(killTimer);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  proc.on("close", code => {
    clearTimeout(killTimer);
    if (res.headersSent) return;
    if (code !== 0) {
      console.error("newsletter generate exit", code, stderr);
      return res.status(500).json({ error: `claude exited ${code}`, stderr });
    }
    if (!existsSync(targetPath))
      return res.status(500).json({ error: "newsletter file not produced", stderr });
    res.json({ name: targetName, content: readFileSync(targetPath, "utf8") });
  });
});

// Sweep — AI board review. GET returns the cached result; POST re-runs the
// AI pass over all in_progress/wfhuman cards (blocking, ~1-2 min — same
// pattern as newsletter generation).
app.get("/api/sweep", (req, res) => {
  res.json(readSweepCache());
});

app.post("/api/sweep/run", requireAdmin, async (req, res) => {
  try {
    const projects = getAllProjects({ includeCompleted: false })
      .filter((p) => (p.status === "in_progress" || p.status === "wfhuman") && p.tmux_session !== "operator");
    if (projects.length === 0) return res.json({ generated: null, quick_wins: [], blocked: [], suggestions: [] });
    const result = await runSweep(projects);
    res.json(result);
  } catch (err) {
    console.error("POST /api/sweep/run error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Kick off an on-demand calendar sync (fire-and-forget; cron covers routine runs)
app.post("/api/calendar/sync", (req, res) => {
  // Route through the coalescing runner so an on-demand sync can never race a
  // webhook- or PATCH-triggered run against the same Notion/Google state.
  scheduleCalendarSync(0);
  res.json({ ok: true });
});

app.get("/api/projects/:id/timers", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const project = getProjectById(id);
    if (!project) {
      return res.status(404).json({ error: "project not found" });
    }
    const limit = parseInt(req.query.limit || "20", 10);
    const entries = await getTimerEntriesForProject(project, limit);
    res.json(entries);
  } catch (err) {
    console.error("GET /api/projects/:id/timers error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/projects/:id/notion-title", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const project = getProjectById(id);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!project.notion_id) return res.json({ title: null });
    const title = await fetchNotionTitle(project.notion_id);
    res.json({ title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve OpenDia files (images/attachments) — scoped to ~/OpenDia/
app.get("/api/file", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: "path required" });

  // Resolve ~ to home dir, then ensure it's under ~/OpenDia/
  const resolved = resolve(filePath.replace(/^~/, process.env.HOME));
  const openDiaRoot = resolve(process.env.HOME, "OpenDia");
  if (resolved !== openDiaRoot && !resolved.startsWith(openDiaRoot + sep)) {
    return res.status(403).json({ error: "path must be under ~/OpenDia/" });
  }

  res.sendFile(resolved, (err) => {
    if (err) res.status(404).json({ error: "file not found" });
  });
});

app.get("/api/projects/:id/inbox", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const items = getInboxItemsByProject(id);
    res.json(items);
  } catch (err) {
    console.error("GET /api/projects/:id/inbox error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Inbox API ─────────────────────────────────────────────────────────────────

ensureInboxTable();
ensureClientAliasesTable();
ensureProjectsColumns();
ensureAgentsTables();

// ── Running-timer → In Progress reconciler ────────────────────────────────────
// A timer left running on an Ice/WFHuman/Completed card is invisible (the board
// shows one status at a time), so a forgotten timer can run for days unseen. Any
// card with a running timer is forced to In Progress so it surfaces in the column
// that actually gets watched. Promote only, never demote — stopping a timer leaves
// the card in In Progress, which is honest. Steady state writes nothing: we only
// touch a card whose status actually differs.
let reconcileInFlight = false;
async function reconcileRunningTimers() {
  if (reconcileInFlight) return;
  reconcileInFlight = true;
  try {
    const timers = await getActiveTimers();
    let changed = false;
    const seen = new Set();
    for (const t of timers) {
      // Exact join only: project_id when present (dashboard-started), else
      // tmux_session (always written). Never the fuzzy matchProject here.
      const project = (t.project_id && getProjectById(t.project_id))
        || getProjectByTmuxSession(t.tmux_session);
      if (!project || seen.has(project.id)) continue;
      seen.add(project.id);
      if (project.status === "in_progress") continue;
      moveProjectToTop(project.id, "in_progress");
      pushNotionStatus(project, "in_progress");
      changed = true;
      console.log(`reconciler: project ${project.id} (${project.name}) ${project.status} → in_progress (timer running)`);
    }
    if (changed) scheduleCalendarSync();
  } catch (err) {
    console.error("reconcileRunningTimers error:", err.message);
  } finally {
    reconcileInFlight = false;
  }
}
reconcileRunningTimers();
setInterval(reconcileRunningTimers, 60_000);

app.get("/api/inbox", (req, res) => {
  try {
    res.json(getAllInboxItems());
  } catch (err) {
    console.error("GET /api/inbox error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/inbox/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const updated = updateInboxItem(id, req.body);
    if (!updated) return res.status(404).json({ error: "inbox item not found" });

    // Re-link project when classification fields change
    if (req.body.client_hint !== undefined || req.body.division_hint !== undefined) {
      const item = getInboxItemById(id);
      if (item) {
        const matched = matchProject(item.client_hint, item.division_hint, item.short_slug);
        const projectId = matched
          ? matched.id
          : ensureProjectForInbox(item.client_hint, item.division_hint, item.short_slug, item.subject, item.project_id);
        updateInboxItem(id, { project_id: projectId });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/inbox/:id error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Soft-delete: sets status='dismissed' to preserve project link and audit trail
app.delete("/api/inbox/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const updated = updateInboxItem(id, { status: "dismissed" });
    if (!updated) return res.status(404).json({ error: "inbox item not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/inbox/:id error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/inbox/:id/redispatch", requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = getInboxItemById(id);
    if (!item) return res.status(404).json({ error: "inbox item not found" });
    if (!item.gmail_id) return res.status(400).json({ error: "item has no gmail_id" });

    const scriptPath = `${process.env.HOME}/OpenDia/scripts/inbox_stage_b.py`;
    const child = spawn("python3", [scriptPath, "--redispatch", item.gmail_id], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    res.json({ ok: true, gmail_id: item.gmail_id });
  } catch (err) {
    console.error("POST /api/inbox/:id/redispatch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/inbox/:id/approve-server", requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = getInboxItemById(id);
    if (!item) return res.status(404).json({ error: "inbox item not found" });
    if (!item.gmail_id) return res.status(400).json({ error: "item has no gmail_id" });
    if (!item.requires_server_access) return res.status(400).json({ error: "item does not require server access" });

    const scriptPath = `${process.env.HOME}/OpenDia/scripts/inbox_stage_b.py`;
    const child = spawn("python3", [scriptPath, "--server-dispatch", item.gmail_id], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/inbox/:id/approve-server error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Runs the gated half of the Tally lead intake: Notion task, Build Registry
// row, and 2-3 Gemini mockups. Detached rather than in-process because the work
// is 30-90s (and up to ~6 min worst case on image-gen timeouts); the client
// picks up the status change on its normal 15s poll.
app.post("/api/inbox/:id/approve-lead", requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = getInboxItemById(id);
    if (!item) return res.status(404).json({ error: "inbox item not found" });
    if (!/^tally:68QDQA:[A-Za-z0-9_-]+$/.test(item.gmail_id || "")) {
      return res.status(400).json({ error: "item is not a Tally lead" });
    }
    if (item.status !== "new-lead") {
      return res.status(400).json({ error: `lead is ${item.status}, not awaiting approval` });
    }

    const scriptPath = `${process.env.HOME}/OpenDia/scripts/intake_pipeline.py`;
    // The pipeline needs the API keys the cron wrapper sources from inbox.env;
    // the dashboard's own env does not carry them.
    const child = spawn(
      "bash",
      ["-lc",
       `set -a; [ -f "$HOME/.config/opendia/inbox.env" ] && . "$HOME/.config/opendia/inbox.env"; set +a; ` +
       `exec python3 "${scriptPath}" approve-lead ${id}`],
      { detached: true, stdio: "ignore", env: { ...process.env } },
    );
    child.unref();

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/inbox/:id/approve-lead error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/inbox/:id/preview", requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { dev_preview_url, dev_branch, repo_path } = req.body;
    if (!dev_preview_url) return res.status(400).json({ error: "dev_preview_url required" });
    if (dev_branch !== undefined && dev_branch !== null && !isSafeGitRef(dev_branch))
      return res.status(400).json({ error: "invalid dev_branch" });
    if (repo_path !== undefined && repo_path !== null && !isSafeRepoPath(repo_path))
      return res.status(400).json({ error: "invalid repo_path" });
    const updated = updateInboxItem(id, { dev_preview_url, dev_branch, repo_path });
    if (!updated) return res.status(404).json({ error: "inbox item not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/inbox/:id/preview error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/inbox/:id/approve-deploy", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = getInboxItemById(id);
    if (!item) return res.status(404).json({ error: "inbox item not found" });
    if (!item.dev_branch) return res.status(400).json({ error: "No dev branch recorded for this item" });
    if (!item.repo_path) return res.status(400).json({ error: "No repo_path recorded for this item" });
    // Values predate validation in /preview, so re-check before they reach git.
    if (!isSafeGitRef(item.dev_branch)) return res.status(400).json({ error: "invalid dev_branch" });
    if (!isSafeRepoPath(item.repo_path)) return res.status(400).json({ error: "invalid repo_path" });

    const fluxRoot = resolve(process.env.HOME, "FluxCC");
    const repoDir = resolve(fluxRoot, item.repo_path);
    if (repoDir !== fluxRoot && !repoDir.startsWith(fluxRoot + sep))
      return res.status(400).json({ error: "repo_path escapes FluxCC root" });
    if (!existsSync(resolve(repoDir, ".git")))
      return res.status(400).json({ error: "repo_path is not a git repository" });

    const branch = item.dev_branch;
    const steps = [
      ["checkout", "main"],
      ["pull", "origin", "main"],
      ["merge", branch, "--no-edit"],
      ["push", "origin", "main"],
      ["branch", "-d", branch],
      ["push", "origin", "--delete", branch],
    ];

    let output = "";
    for (const args of steps) {
      const step = await runGit(args, repoDir);
      output += `$ git ${args.join(" ")}\n${step.stdout}`;
      if (step.code !== 0) {
        console.error("approve-deploy git failed:", args.join(" "), step.stderr);
        return res.status(500).json({ error: `git ${args[0]} failed`, output });
      }
    }

    updateInboxItem(id, { status: "deployed" });
    res.json({ ok: true, output });
  } catch (err) {
    console.error("POST /api/inbox/:id/approve-deploy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/companies", requireLinnfluxUser, (req, res) => {
  try {
    res.json({ companies: getAllCompanies() });
  } catch (err) {
    console.error("GET /api/companies error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/client-aliases", (req, res) => {
  try {
    res.json(getAllClientAliases());
  } catch (err) {
    console.error("GET /api/client-aliases error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/client-aliases", (req, res) => {
  try {
    const { match_type, match_value, client_hint, division_hint, note } = req.body;
    if (!match_type || !match_value || !client_hint) {
      return res.status(400).json({ error: "match_type, match_value, and client_hint are required" });
    }
    if (!["domain", "email", "substring"].includes(match_type)) {
      return res.status(400).json({ error: "match_type must be domain, email, or substring" });
    }
    insertClientAlias({ match_type, match_value, client_hint, division_hint, note });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("POST /api/client-aliases error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/projects/:id/ingest-email", requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const project = getProjectById(id);
    if (!project) return res.status(404).json({ error: "project not found" });

    const { gmail_id } = req.body;
    if (!gmail_id) return res.status(400).json({ error: "gmail_id is required" });

    const processed = getProcessedGmailIds();
    if (processed.has(gmail_id)) {
      return res.status(409).json({ error: "email already in inbox_items" });
    }

    const scriptPath = `${process.env.HOME}/OpenDia/scripts/check_mail_ingest.py`;
    const tmuxSession = project.tmux_session || "";
    const child = spawn("python3", [scriptPath, gmail_id, String(id), tmuxSession], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    const mode = project.tmux_session ? "inject" : "spawn";
    res.json({ ok: true, gmail_id, mode });
  } catch (err) {
    console.error("POST /api/projects/:id/ingest-email error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Session log viewer
app.get("/api/inbox/:id/log", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = getInboxItemById(id);
    if (!item) return res.status(404).json({ error: "inbox item not found" });
    if (!item.session_name) return res.json({ lines: "", exists: false });

    const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 80, 1), 500);
    const logPath = resolve(process.env.HOME, "OpenDia", "logs", "sessions", `${item.session_name}.log`);

    // Path-traversal guard
    const logRoot = resolve(process.env.HOME, "OpenDia", "logs", "sessions");
    if (!logPath.startsWith(logRoot)) {
      return res.status(403).json({ error: "invalid log path" });
    }

    if (!existsSync(logPath)) return res.json({ lines: "", exists: false });

    const content = readFileSync(logPath, "utf8");
    const allLines = content.split("\n");
    const lines = allLines.slice(-tail).join("\n");
    res.json({ lines, exists: true });
  } catch (err) {
    console.error("GET /api/inbox/:id/log error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Terminal WebSocket + REST endpoints (must be before static catch-all)
const server = http.createServer(app);
mountTerminal(server, app);

// Spark: per-card next-step runs, streamed over SSE (also before the catch-all)
mountSpark(app);

// Runrooms: read-only view over ~/OpenDia/runrooms/*/plan.json
registerRunroomRoutes(app);
// Planrooms: the standing plan per card that a runroom adopts (also before the catch-all)
registerPlanroomRoutes(app);

// Mailroom: browse inbox + standing-session conversation (admin)
registerMailroomRoutes(app);

// OpenDia Agents: scheduled scan-and-propose agents (admin)
mountAgents(app);

// Second client, same API, same auth. Mounted before the dashboard
// catch-all so /prm/* never falls through to the dashboard SPA. Built from
// its own private repo, not this one; PRM_DIST points at its dist.
const prmDist = process.env.PRM_DIST || resolve(process.env.HOME, "planrunmail", "dist");
app.use("/prm", express.static(prmDist));
app.get("/prm/*", (_req, res) => {
  res.sendFile(resolve(prmDist, "index.html"));
});

// Serve static files in production
const distPath = resolve(__dirname, "..", "client", "dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(resolve(distPath, "index.html"));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenDia Dashboard API listening on http://127.0.0.1:${PORT}`);
});
