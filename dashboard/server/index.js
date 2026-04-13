import express from "express";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PORT } from "./config.js";
import { getAllProjects, updateProject, getProjectById, reorderProjects, matchProject, createProject, getAllInboxItems, updateInboxItem, deleteInboxItem, ensureInboxTable, getInboxItemById, ensureClientAliasesTable, getAllClientAliases, insertClientAlias, getInboxItemsByProject, ensureProjectForInbox } from "./db.js";
import { spawn } from "child_process";
import { getTimerEntriesForProject, getActiveTimers, getAllTimerEntries } from "./timers.js";
import { fetchNotionPage, fetchNotionTitle, appendToggleBlocks, searchNotionForProject, appendTimerLog, getTimerMarkers } from "./notion.js";
import { searchRecentEmails } from "./gmail.js";
import { analyzeSync } from "./ai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// API routes
app.get("/api/projects", (req, res) => {
  try {
    const includeCompleted = req.query.include_completed === "true";
    const projects = getAllProjects({ includeCompleted });
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
    const updated = updateProject(id, fields);
    if (!updated) {
      return res.status(404).json({ error: "project not found" });
    }
    res.json({ ok: true });
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

app.post("/api/projects/:id/sync", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const project = getProjectById(id);
    if (!project) {
      return res.status(404).json({ error: "project not found" });
    }

    const result = { notion: null, emails: [], analysis: null, updated: {} };

    // Auto-discover Notion task if not linked
    if (!project.notion_id) {
      const discovered = await searchNotionForProject(project.name, project.company_name);
      if (discovered) {
        updateProject(id, { notion_id: discovered });
        project.notion_id = discovered;
        result.updated.notion_id = discovered;
      }
    }

    // Fetch Notion data if linked
    if (project.notion_id) {
      result.notion = await fetchNotionPage(project.notion_id);
    }

    // Search Gmail for recent emails
    try {
      result.emails = await searchRecentEmails(project.company_name, {
        shortName: project.company_short,
      });
    } catch (err) {
      console.error("Gmail search error:", err.message);
    }

    // AI analysis if we have emails or Notion data
    if (result.emails.length > 0 || result.notion) {
      try {
        result.analysis = await analyzeSync({
          project,
          emails: result.emails,
          notion: result.notion,
        });

        if (result.analysis) {
          // Update next_step if AI suggests a change
          if (result.analysis.nextStep && result.analysis.nextStep !== project.next_step) {
            updateProject(id, { next_step: result.analysis.nextStep });
            result.updated.next_step = result.analysis.nextStep;
          }

          // Append change requests to Notion as toggle blocks
          if (result.analysis.changeRequests?.length > 0 && project.notion_id) {
            try {
              await appendToggleBlocks(
                project.notion_id,
                result.analysis.changeRequests
              );
              result.updated.notion_appended = true;
            } catch (err) {
              console.error("Notion append error:", err.message);
            }
          }
        }
      } catch (err) {
        console.error("AI analysis error:", err.message);
      }
    }

    res.json(result);
  } catch (err) {
    console.error("POST /api/projects/:id/sync error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/timers/active", async (req, res) => {
  try {
    const timers = await getActiveTimers();
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
  if (!resolved.startsWith(openDiaRoot)) {
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
          : ensureProjectForInbox(item.client_hint, item.division_hint, item.short_slug, item.subject);
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

app.post("/api/inbox/:id/redispatch", (req, res) => {
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

app.post("/api/inbox/:id/approve-server", (req, res) => {
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

// Serve static files in production
const distPath = resolve(__dirname, "..", "client", "dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(resolve(distPath, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenDia Dashboard API listening on http://0.0.0.0:${PORT}`);
});
