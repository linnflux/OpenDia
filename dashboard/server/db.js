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
  SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id,
         c.name AS company_name, c.short_name AS company_short,
         d.name AS division
  FROM projects p
  LEFT JOIN companies c ON p.company_id = c.id
  LEFT JOIN divisions d ON p.division_id = d.id
  ORDER BY p.sort_order ASC, p.updated_at DESC
`;

const VALID_STATUSES = new Set(["in_progress", "wfhuman", "completed", "ice"]);

export function getAllProjects() {
  return getDb().prepare(GET_ALL_PROJECTS).all();
}

export function getProjectById(id) {
  return getDb().prepare(`${GET_ALL_PROJECTS.replace("ORDER BY p.updated_at DESC", "WHERE p.id = ?")}`).get(id);
}

const UPDATABLE_FIELDS = new Set(["status", "notes", "tmux_session"]);

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
