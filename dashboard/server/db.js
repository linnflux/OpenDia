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
  SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id, p.next_step, p.updated_at,
         c.name AS company_name, c.short_name AS company_short,
         c.notion_id AS company_notion_id, c.website AS company_website,
         d.name AS division,
         (SELECT COUNT(*) FROM inbox_items WHERE project_id = p.id AND status NOT IN ('done', 'dismissed')) AS inbox_count
  FROM projects p
  LEFT JOIN companies c ON p.company_id = c.id
  LEFT JOIN divisions d ON p.division_id = d.id
  ORDER BY p.sort_order ASC, p.updated_at DESC
`;

const VALID_STATUSES = new Set(["in_progress", "wfhuman", "completed", "ice"]);

const GET_ACTIVE_PROJECTS = `
  SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id, p.next_step, p.updated_at,
         c.name AS company_name, c.short_name AS company_short,
         c.notion_id AS company_notion_id, c.website AS company_website,
         d.name AS division,
         (SELECT COUNT(*) FROM inbox_items WHERE project_id = p.id AND status NOT IN ('done', 'dismissed')) AS inbox_count
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
    if (key === "division") {
      const row = getDb().prepare("SELECT id FROM divisions WHERE LOWER(name) = LOWER(?)").get(val);
      if (!row) throw new Error(`Unknown division: ${val}`);
      sets.push("division_id = ?");
      vals.push(row.id);
      continue;
    }
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

const MATCH_STOPWORDS = new Set([
  "the","for","and","with","fix","new","get","add","to","of","in","on","a","an",
  "is","at","or","it","re","per","via","from","into","out","up","down","use","set"
]);

function matchTokenize(s) {
  const out = new Set();
  for (const t of (s || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 2 && !MATCH_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function matchSharedTokens(a, b) {
  const aT = matchTokenize(a);
  if (aT.size === 0) return 0;
  const bT = matchTokenize(b);
  let n = 0;
  for (const t of aT) if (bT.has(t)) n++;
  return n;
}

export function matchProject(client, division, task, project) {
  const clientLower = (client || "").toLowerCase();
  const divisionLower = (division || "").toLowerCase();
  const taskLower = (task || "").toLowerCase();
  const projectLower = (project || "").toLowerCase();

  const projects = getDb().prepare(`
    SELECT p.id, p.name, p.status,
           c.name AS company_name, c.short_name AS company_short,
           d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
  `).all();

  // First pass: exact project name match (highest priority)
  if (projectLower) {
    for (const p of projects) {
      if ((p.name || "").toLowerCase() === projectLower) return p;
    }
  }

  // Scored pass: among projects whose client matches, pick the best by
  // (task text overlap with name) + (division match) + (active status bonus).
  // Replaces the old "first client+division hit wins", which mis-attributed
  // timers to completed projects when a newer in_progress project existed
  // for the same (client, division) pair.
  let best = null;
  let bestScore = 0;
  for (const p of projects) {
    const companyLower = (p.company_name || "").toLowerCase();
    const shortLower = (p.company_short || "").toLowerCase();
    const pDivLower = (p.division || "").toLowerCase();
    const nameLower = (p.name || "").toLowerCase();

    const clientMatch = clientLower && (
      companyLower === clientLower ||
      shortLower === clientLower ||
      (companyLower && (companyLower.includes(clientLower) || clientLower.includes(companyLower))) ||
      (shortLower && (shortLower.includes(clientLower) || clientLower.includes(shortLower)))
    );
    if (!clientMatch) continue;

    const divMatch = divisionLower && pDivLower === divisionLower;
    const taskSubstr = taskLower && nameLower && (nameLower.includes(taskLower) || taskLower.includes(nameLower));
    const sharedTokens = matchSharedTokens(taskLower, nameLower);

    // Require at least one signal beyond "same client" to be considered.
    if (!divMatch && !taskSubstr && sharedTokens === 0) continue;

    let score = 0;
    if (taskSubstr) score += 10;              // strongest: full substring match
    score += sharedTokens * 3;                 // per shared significant token
    if (divMatch) score += 2;                  // same division
    if (p.status !== "completed") score += 1;  // prefer active work on ties

    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }

  return best;
}

export function matchProjectCandidates(client, division, task, limit = 3) {
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

  const clientMatched = [];
  const scored = [];

  for (const p of projects) {
    const companyLower = (p.company_name || "").toLowerCase();
    const shortLower = (p.company_short || "").toLowerCase();
    const pDivLower = (p.division || "").toLowerCase();
    const nameLower = (p.name || "").toLowerCase();

    const clientMatch = clientLower && (
      companyLower === clientLower ||
      shortLower === clientLower ||
      (companyLower && (companyLower.includes(clientLower) || clientLower.includes(companyLower))) ||
      (shortLower && (shortLower.includes(clientLower) || clientLower.includes(shortLower)))
    );
    if (!clientMatch) continue;

    clientMatched.push(p);

    const divMatch = divisionLower && pDivLower === divisionLower;
    const taskSubstr = taskLower && nameLower && (nameLower.includes(taskLower) || taskLower.includes(nameLower));
    const sharedTokens = matchSharedTokens(taskLower, nameLower);

    // Require at least one signal beyond "same client"
    if (!divMatch && !taskSubstr && sharedTokens === 0) continue;

    let score = 0;
    if (taskSubstr) score += 10;
    score += sharedTokens * 3;
    if (divMatch) score += 2;
    if (p.status !== "completed") score += 1;

    scored.push({ ...p, score });
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // Relaxed pass: return client-only matches so user can still see same-client options
  if (clientMatched.length > 0) {
    const relaxed = clientMatched.map((p) => ({
      ...p,
      score: p.status !== "completed" ? 1 : 0,
    }));
    relaxed.sort((a, b) => b.score - a.score);
    return relaxed.slice(0, limit);
  }

  return [];
}

export function createProject({ name, companyName, divisionName, status = "in_progress", notionId = null }) {
  const db = getDb();

  let companyId = null;
  if (companyName) {
    const company = db.prepare(
      "SELECT id FROM companies WHERE LOWER(name) = LOWER(?) OR LOWER(short_name) = LOWER(?)"
    ).get(companyName, companyName);
    if (company) companyId = company.id;
  }

  let divisionId = null;
  if (divisionName) {
    const division = db.prepare(
      "SELECT id FROM divisions WHERE LOWER(name) = LOWER(?)"
    ).get(divisionName);
    if (division) divisionId = division.id;
  }

  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  let newId;
  db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO projects (name, company_id, division_id, status, notion_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(name, companyId, divisionId, status, notionId);
    newId = result.lastInsertRowid;
    insertAtTopOfColumn(db, status, newId);
  })();

  return getProjectById(newId);
}

// ── Inbox items ───────────────────────────────────────────────────────────────

export function ensureInboxTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      gmail_id              TEXT UNIQUE,
      thread_id             TEXT,
      from_addr             TEXT,
      subject               TEXT,
      client_hint           TEXT,
      division_hint         TEXT,
      priority              TEXT DEFAULT 'normal',
      short_slug            TEXT,
      prompt_text           TEXT,
      status                TEXT DEFAULT 'classified',
      session_name          TEXT,
      error_text            TEXT,
      notes                 TEXT,
      requires_server_access INTEGER DEFAULT 0,
      estimated_minutes     INTEGER DEFAULT 0,
      timer_marker          TEXT,
      project_hint          TEXT,
      project_id            INTEGER REFERENCES projects(id),
      dev_preview_url       TEXT,
      dev_branch            TEXT,
      repo_path             TEXT,
      created_at            DATETIME DEFAULT (datetime('now')),
      updated_at            DATETIME DEFAULT (datetime('now'))
    )
  `);
  // Migrate: add columns if they don't exist yet
  const cols = db.pragma("table_info(inbox_items)").map((r) => r.name);
  if (!cols.includes("notes")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN notes TEXT");
  }
  if (!cols.includes("requires_server_access")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN requires_server_access INTEGER DEFAULT 0");
  }
  if (!cols.includes("estimated_minutes")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN estimated_minutes INTEGER DEFAULT 0");
  }
  if (!cols.includes("timer_marker")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN timer_marker TEXT");
  }
  if (!cols.includes("project_hint")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN project_hint TEXT");
  }
  if (!cols.includes("project_id")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN project_id INTEGER REFERENCES projects(id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_items_project_id ON inbox_items(project_id)");
  }
  if (!cols.includes("dev_preview_url")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN dev_preview_url TEXT");
  }
  if (!cols.includes("dev_branch")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN dev_branch TEXT");
  }
  if (!cols.includes("repo_path")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN repo_path TEXT");
  }
}

export function ensureClientAliasesTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS client_aliases (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type    TEXT NOT NULL,
      match_value   TEXT NOT NULL,
      client_hint   TEXT NOT NULL,
      division_hint TEXT,
      note          TEXT,
      created_at    DATETIME DEFAULT (datetime('now')),
      UNIQUE(match_type, match_value)
    )
  `);
}

export function getAllInboxItems() {
  ensureInboxTable();
  return getDb().prepare(`
    SELECT i.*, p.name AS project_name
    FROM inbox_items i
    LEFT JOIN projects p ON i.project_id = p.id
    ORDER BY i.created_at DESC LIMIT 200
  `).all();
}

export function getInboxItemsByProject(projectId) {
  ensureInboxTable();
  return getDb().prepare(`
    SELECT i.*, p.name AS project_name
    FROM inbox_items i
    LEFT JOIN projects p ON i.project_id = p.id
    WHERE i.project_id = ?
    ORDER BY i.created_at DESC
  `).all(projectId);
}

const INBOX_UPDATABLE = new Set([
  "status", "session_name", "error_text",
  "client_hint", "division_hint", "priority", "notes",
  "requires_server_access", "estimated_minutes", "timer_marker",
  "project_hint", "project_id",
  "dev_preview_url", "dev_branch", "repo_path",
]);

export function updateInboxItem(id, fields) {
  ensureInboxTable();
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(fields)) {
    if (!INBOX_UPDATABLE.has(key)) continue;
    sets.push(`${key} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) throw new Error("No valid inbox fields to update");
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  const result = getDb()
    .prepare(`UPDATE inbox_items SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
  return result.changes > 0;
}

export function deleteInboxItem(id) {
  ensureInboxTable();
  return getDb().prepare("DELETE FROM inbox_items WHERE id = ?").run(id).changes > 0;
}

export function getInboxItemById(id) {
  ensureInboxTable();
  return getDb().prepare("SELECT * FROM inbox_items WHERE id = ?").get(id);
}

export function getProcessedGmailIds() {
  ensureInboxTable();
  return new Set(
    getDb().prepare("SELECT gmail_id FROM inbox_items WHERE gmail_id IS NOT NULL").all()
      .map((r) => r.gmail_id)
  );
}

export function getAllClientAliases() {
  ensureClientAliasesTable();
  return getDb().prepare(
    "SELECT * FROM client_aliases ORDER BY match_type, match_value"
  ).all();
}

export function insertClientAlias({ match_type, match_value, client_hint, division_hint, note }) {
  ensureClientAliasesTable();
  getDb().prepare(`
    INSERT INTO client_aliases (match_type, match_value, client_hint, division_hint, note)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(match_type, match_value)
    DO UPDATE SET client_hint=excluded.client_hint,
                  division_hint=excluded.division_hint,
                  note=excluded.note
  `).run(match_type, (match_value || "").toLowerCase(), client_hint, division_hint || null, note || null);
}

export function ensureProjectForInbox(clientHint, divisionHint, shortSlug, subject) {
  const db = getDb();
  const name = (shortSlug || "inbox-item").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  let companyId = null;
  if (clientHint && clientHint.toLowerCase() !== "unknown") {
    const company = db.prepare(
      "SELECT id FROM companies WHERE LOWER(name) = LOWER(?) OR LOWER(short_name) = LOWER(?)"
    ).get(clientHint, clientHint);
    if (company) companyId = company.id;
  }

  let divisionId = null;
  if (divisionHint && divisionHint.toLowerCase() !== "unknown") {
    const division = db.prepare(
      "SELECT id FROM divisions WHERE LOWER(name) = LOWER(?)"
    ).get(divisionHint);
    if (division) divisionId = division.id;
  }

  let newId;
  db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO projects (name, company_id, division_id, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, 'wfhuman', ?, datetime('now'), datetime('now'))
    `).run(name, companyId, divisionId, `Auto-created from inbox: ${subject}`);
    newId = result.lastInsertRowid;
    insertAtTopOfColumn(db, 'wfhuman', newId);
  })();

  return newId;
}

function insertAtTopOfColumn(db, status, projectId) {
  db.prepare("UPDATE projects SET sort_order = sort_order + 1 WHERE status = ? AND sort_order IS NOT NULL").run(status);
  db.prepare("UPDATE projects SET sort_order = 0 WHERE id = ?").run(projectId);
}

export function moveProjectToTop(projectId, newStatus) {
  const db = getDb();
  db.transaction(() => {
    insertAtTopOfColumn(db, newStatus, projectId);
    db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, projectId);
  })();
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
