import express from "express";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PORT } from "./config.js";
import { getAllProjects, updateProject, getProjectById, reorderProjects, matchProject } from "./db.js";
import { getTimerEntriesForProject } from "./timers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// API routes
app.get("/api/projects", (_req, res) => {
  try {
    const projects = getAllProjects();
    res.json(projects);
  } catch (err) {
    console.error("GET /api/projects error:", err.message);
    res.status(500).json({ error: err.message });
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

// Serve static files in production
const distPath = resolve(__dirname, "..", "client", "dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(resolve(distPath, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenDia Dashboard API listening on http://0.0.0.0:${PORT}`);
});
