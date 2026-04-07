import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { readonly: false });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

const GET_ALL_PROJECTS = `
  SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id, p.next_step,
         c.name AS company_name, c.short_name AS company_short,
         c.notion_id AS company_notion_id,
         d.name AS division
  FROM projects p
  LEFT JOIN companies c ON p.company_id = c.id
  LEFT JOIN divisions d ON p.division_id = d.id
  ORDER BY p.sort_order ASC, p.updated_at DESC
`;

const VALID_STATUSES = new Set(["in_progress", "wfhuman", "completed", "ice"]);

const GET_ACTIVE_PROJECTS = `
  SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id, p.next_step,
         c.name AS company_name, c.short_name AS company_short,
         c.notion_id AS company_notion_id,
         d.name AS division
  FROM projects p
  LEFT JOIN companies c ON p.company_id = c.id
  LEFT JOIN divisions d ON p.division_id = d.id
  WHERE p.status != 'completed'
  ORDER BY p.sort_order ASC, p.updated_at DESC
`;

export function getAllProjects({ includeCompleted = false } = {}) {
  const query = includeCompleted ? GET_ALL_PROJECTS : GET_ACTIVE_PROJECTS;
  return getDb().prepare(query).all();
}

export function getProjectById(id) {
  return getDb().prepare(`
    SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id, p.next_step,
           c.name AS company_name, c.short_name AS company_short,
           d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE p.id = ?
  `).get(id);
}

const UPDATABLE_FIELDS = new Set(["name", "status", "notes", "tmux_session", "next_step", "notion_id"]);

export function updateProject(id, fields) {
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(fields)) {
    if (!UPDATABLE_FIELDS.has(key)) continue;
    if (key === "status" && !VALID_STATUSES.has(val)) {
      throw new Error(`Invalid status: ${val}`);
    }
    sets.push(`${key} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) throw new Error("No valid fields to update");
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  const result = getDb()
    .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
  return result.changes > 0;
}

export function matchProject(client, division, task) {
  const clientLower = (client || "").toLowerCase();
  const divisionLower = (division || "").toLowerCase();
  const taskLower = (task || "").toLowerCase();

  const projects = getDb().prepare(`
    SELECT p.id, p.name, p.status,
           c.name AS company_name, c.short_name AS company_short,
           d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
  `).all();

  for (const p of projects) {
    const companyLower = (p.company_name || "").toLowerCase();
    const shortLower = (p.company_short || "").toLowerCase();
    const pDivLower = (p.division || "").toLowerCase();
    const nameLower = (p.name || "").toLowerCase();

    const clientMatch = clientLower && (companyLower === clientLower || shortLower === clientLower);
    const divMatch = divisionLower && pDivLower === divisionLower;
    const taskMatch = taskLower && (nameLower.includes(taskLower) || taskLower.includes(nameLower));

    if (clientMatch && divMatch) return p;
    if (clientMatch && taskMatch) return p;
  }

  return null;
}

export function reorderProjects(status, ids) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE projects SET sort_order = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
  );
  const run = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      stmt.run(i, status, ids[i]);
    }
  });
  run();
}
