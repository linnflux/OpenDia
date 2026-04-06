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
  SELECT p.id, p.name, p.status, p.tmux_session, p.notes,
         c.name AS company_name, c.short_name AS company_short,
         d.name AS division
  FROM projects p
  LEFT JOIN companies c ON p.company_id = c.id
  LEFT JOIN divisions d ON p.division_id = d.id
  ORDER BY p.updated_at DESC
`;

const VALID_STATUSES = new Set(["in_progress", "wfhuman", "completed", "ice"]);

export function getAllProjects() {
  return getDb().prepare(GET_ALL_PROJECTS).all();
}

export function updateProjectStatus(id, status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const result = getDb()
    .prepare(
      "UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(status, id);
  return result.changes > 0;
}
