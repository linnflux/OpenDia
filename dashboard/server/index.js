import http from "http";
import express from "express";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PORT } from "./config.js";
import { mountTerminal } from "./terminal.js";
import { requireLinnfluxUser, requireAdmin } from "./auth.js";
import { getAllProjects, updateProject, getProjectById, reorderProjects, matchProject, matchProjectCandidates, createProject, getAllInboxItems, updateInboxItem, deleteInboxItem, ensureInboxTable, getInboxItemById, ensureClientAliasesTable, getAllClientAliases, insertClientAlias, getInboxItemsByProject, ensureProjectForInbox, getProcessedGmailIds, moveProjectToTop, getStaleInProgressProjects } from "./db.js";
import { spawn, exec } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { getTimerEntriesForProject, getActiveTimers, getAllTimerEntries, getWeekDetail, currentWeekKey } from "./timers.js";
import { fetchNotionPage, fetchNotionTitle, appendToggleBlocks, searchNotionForProject, appendTimerLog, getTimerMarkers } from "./notion.js";
import { searchRecentEmails } from "./gmail.js";
import { analyzeSync } from "./ai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(requireLinnfluxUser);
app.get("/api/me", (req, res) => res.json(req.user));

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

app.post("/api/billing/push", requireAdmin, (_req, res) => {
  res.status(501).json({ error: "not_implemented", note: "Push-to-sheet coming in follow-up plan" });
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
  const proc = spawn(claudeBin, [
    "-p", prompt,
    "--permission-mode", "bypassPermissions",
    "--output-format", "json",
  ], { cwd: resolve(process.env.HOME, "OpenDia") });

  let stderr = "";
  proc.stderr.on("data", d => { stderr += d; });
  proc.on("error", err => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  proc.on("close", code => {
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

app.patch("/api/inbox/:id/preview", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { dev_preview_url, dev_branch, repo_path } = req.body;
    if (!dev_preview_url) return res.status(400).json({ error: "dev_preview_url required" });
    const updated = updateInboxItem(id, { dev_preview_url, dev_branch, repo_path });
    if (!updated) return res.status(404).json({ error: "inbox item not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/inbox/:id/preview error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/inbox/:id/approve-deploy", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = getInboxItemById(id);
    if (!item) return res.status(404).json({ error: "inbox item not found" });
    if (!item.dev_branch) return res.status(400).json({ error: "No dev branch recorded for this item" });
    if (!item.repo_path) return res.status(400).json({ error: "No repo_path recorded for this item" });

    const repoDir = resolve(process.env.HOME, "FluxCC", item.repo_path);
    const script = [
      `cd "${repoDir}"`,
      `git checkout main`,
      `git pull origin main`,
      `git merge ${item.dev_branch} --no-edit`,
      `git push origin main`,
      `git branch -d ${item.dev_branch}`,
      `git push origin --delete ${item.dev_branch}`,
    ].join(" && ");

    exec(script, (err, stdout, stderr) => {
      if (err) {
        console.error("approve-deploy exec error:", stderr);
        return res.status(500).json({ error: stderr || err.message });
      }
      updateInboxItem(id, { status: "deployed" });
      res.json({ ok: true, output: stdout });
    });
  } catch (err) {
    console.error("POST /api/inbox/:id/approve-deploy error:", err.message);
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

app.post("/api/projects/:id/check-mail", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const project = getProjectById(id);
    if (!project) return res.status(404).json({ error: "project not found" });

    let emails = [];
    try {
      emails = await searchRecentEmails(project.company_name, { shortName: project.company_short });
    } catch (err) {
      console.error("Gmail search error:", err.message);
    }

    const processed = getProcessedGmailIds();
    const candidates = emails.filter((e) => !processed.has(e.id));

    res.json(candidates);
  } catch (err) {
    console.error("POST /api/projects/:id/check-mail error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:id/ingest-email", (req, res) => {
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

// Serve static files in production
const distPath = resolve(__dirname, "..", "client", "dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(resolve(distPath, "index.html"));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenDia Dashboard API listening on http://127.0.0.1:${PORT}`);
});
