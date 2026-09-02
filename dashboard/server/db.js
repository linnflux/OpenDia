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
  SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id, p.next_step, p.updated_at, p.tags, p.goal,
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
  SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id, p.next_step, p.updated_at, p.tags, p.goal,
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
    SELECT p.id, p.name, p.status, p.tmux_session, p.notes, p.notion_id, p.next_step, p.tags, p.goal,
           p.company_id, c.name AS company_name, c.short_name AS company_short,
           c.notion_id AS company_notion_id,
           d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE p.id = ?
  `).get(id);
}

const UPDATABLE_FIELDS = new Set(["name", "status", "notes", "tmux_session", "next_step", "notion_id", "tags", "goal"]);

// Migration guard: add columns introduced after the original schema.
// Safe to call on every startup — no-ops once the column exists.
export function ensureProjectsColumns() {
  const cols = getDb().pragma("table_info(projects)").map((r) => r.name);
  if (!cols.includes("tags")) {
    getDb().exec("ALTER TABLE projects ADD COLUMN tags TEXT");
  }
  if (!cols.includes("goal")) {
    getDb().exec("ALTER TABLE projects ADD COLUMN goal TEXT");
  }
  // SQLite sorts NULLs FIRST, so a project with no sort_order pins itself to
  // the top of its column and cannot be dragged off it — drag writes 0..n-1
  // to the rest, which are all still greater than NULL. Park them at the back
  // instead; the first reorder of that column then renumbers everything.
  getDb().exec(`
    UPDATE projects SET sort_order = (
      SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects
    ) WHERE sort_order IS NULL
  `);
}

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

// Word-boundary client match — prevents "part" (short name) matching inside "partners".
function clientContains(haystack, needle) {
  if (!haystack || !needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "i").test(haystack);
}

export function matchProject(client, division, task, project) {
  const clientLower = (client || "").toLowerCase();
  const divisionLower = (division || "").toLowerCase();
  const taskLower = (task || "").toLowerCase();
  const projectLower = (project || "").toLowerCase();

  const projects = getDb().prepare(`
    SELECT p.id, p.name, p.status, p.tags, p.goal,
           c.name AS company_name, c.short_name AS company_short,
           d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE COALESCE(p.tmux_session, '') != 'operator'
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
      (companyLower && (clientContains(companyLower, clientLower) || clientContains(clientLower, companyLower))) ||
      (shortLower && (clientContains(shortLower, clientLower) || clientContains(clientLower, shortLower)))
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
    SELECT p.id, p.name, p.status, p.tags, p.goal,
           c.name AS company_name, c.short_name AS company_short,
           d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE COALESCE(p.tmux_session, '') != 'operator'
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
      (companyLower && (clientContains(companyLower, clientLower) || clientContains(clientLower, companyLower))) ||
      (shortLower && (clientContains(shortLower, clientLower) || clientContains(clientLower, shortLower)))
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

export function createProject({ name, companyName, divisionName, status = "in_progress", notionId = null, goal = null }) {
  const db = getDb();
  const sanitizedName = (name || "").replace(/^[-_\s]+/, "").trim();
  if (!sanitizedName) throw new Error("Project name cannot be empty or consist only of dashes/underscores");
  name = sanitizedName;

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
      INSERT INTO projects (name, company_id, division_id, status, notion_id, goal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(name, companyId, divisionId, status, notionId, goal);
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
      attachment_meta       TEXT,
      lead_approved_at      TEXT,
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
  if (!cols.includes("attachment_meta")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN attachment_meta TEXT");
  }
  if (!cols.includes("lead_approved_at")) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN lead_approved_at TEXT");
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
  // attachment_meta holds the stashed Tally payload (respondent name, email,
  // phone). This list is re-polled every 15s, so keep it out of the wire
  // format; getInboxItemById still returns it for routes that need it.
  return getDb().prepare(`
    SELECT i.*, p.name AS project_name
    FROM inbox_items i
    LEFT JOIN projects p ON i.project_id = p.id
    ORDER BY i.created_at DESC LIMIT 200
  `).all().map(({ attachment_meta, ...rest }) => rest);
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

// The Mailroom's first resolution step for /context: if a thread already
// went through the inbox pipeline, its project match (if any) is already
// known and nothing needs re-guessing from the sender address. Most recent
// row wins on the rare thread with more than one inbox_items entry.
export function getInboxItemByThreadId(threadId) {
  ensureInboxTable();
  return getDb().prepare(
    "SELECT * FROM inbox_items WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(threadId);
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

export function ensureProjectForInbox(clientHint, divisionHint, shortSlug, subject, existingProjectId = null) {
  const db = getDb();
  const name = ((shortSlug || "inbox-item").replace(/^[-_]+/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).trim() || "Inbox Item";

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

  // If the inbox item already owns an auto-created card, update it in place
  // instead of minting another one — otherwise every correction that fails
  // matchProject strands the previous card as an unreachable wfhuman orphan
  // (same dedup-before-side-effects rule as Stage A; see card #204).
  if (existingProjectId) {
    const existing = db.prepare(
      "SELECT id, notes FROM projects WHERE id = ?"
    ).get(existingProjectId);
    if (existing && (existing.notes || "").startsWith("Auto-created from inbox:")) {
      db.prepare(`
        UPDATE projects SET name = ?, company_id = ?, division_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(name, companyId, divisionId, existing.id);
      return existing.id;
    }
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
  // Same guard as updateProject/createProject — without it a bad status is
  // silently written and the card vanishes from every column (found while
  // building the Mailroom card gate, which relies on invalid status = 400).
  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`);
  }
  const db = getDb();
  db.transaction(() => {
    insertAtTopOfColumn(db, newStatus, projectId);
    db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, projectId);
  })();
}

// Exact tmux_session → project lookup for the running-timer reconciler. Uses
// the same key terminal.js trusts, not the fuzzy matchProject scoring. Excludes
// the "operator" sentinel session, consistent with the other project queries.
export function getProjectByTmuxSession(session) {
  if (!session || session === "operator") return undefined;
  return getDb().prepare(`
    SELECT p.id, p.name, p.status, p.tmux_session, p.notion_id
    FROM projects p
    WHERE p.tmux_session = ?
  `).get(session);
}

export function getStaleInProgressProjects(days = 14) {
  return getDb().prepare(`
    SELECT p.id, p.name, p.updated_at, p.next_step,
           c.name AS company_name, d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE p.status = 'in_progress'
      AND p.updated_at < datetime('now', ?)
    ORDER BY p.updated_at ASC
  `).all(`-${parseInt(days, 10)} days`);
}

export function getProjectsByNotionIds(notionIds) {
  if (!notionIds || notionIds.length === 0) return new Map();
  const db = getDb();
  const placeholders = notionIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT p.id AS project_id, p.notion_id,
           c.name AS company_name, c.short_name AS company_short,
           d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE p.notion_id IN (${placeholders})
  `).all(...notionIds);
  return new Map(rows.map((r) => [r.notion_id, r]));
}

export function getAllCompanies() {
  // website is additive (the one API caller just serializes the list) —
  // the Mailroom's sender-domain fallback matches against it.
  return getDb().prepare(`
    SELECT id, name, short_name, website
    FROM companies
    ORDER BY name COLLATE NOCASE ASC
  `).all();
}

export function getCompanyById(id) {
  return getDb().prepare("SELECT * FROM companies WHERE id = ?").get(id);
}

export function createCompany({ name, shortName = null }) {
  const db = getDb();
  const clean = (name || "").trim();
  if (!clean) throw new Error("Company name cannot be empty");
  // Idempotent: an existing name/short_name match is returned, not duplicated.
  const existing = db.prepare(
    "SELECT * FROM companies WHERE LOWER(name) = LOWER(?) OR LOWER(short_name) = LOWER(?)"
  ).get(clean, clean);
  if (existing) return existing;
  const short = (shortName || "").trim() || clean.split(/\s+/)[0];
  const result = db.prepare(`
    INSERT INTO companies (name, short_name, created_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
  `).run(clean, short);
  return getCompanyById(result.lastInsertRowid);
}

// A client's supervisor card: a non-completed card for the same company whose
// tags include "supervisor" (comma-separated scalar, same convention tags.js
// reads). The relationship is tag + company, not a schema link.
export function findSupervisorCard(companyId) {
  if (!companyId) return null;
  const rows = getDb().prepare(`
    SELECT id, name, tmux_session, tags FROM projects
    WHERE company_id = ? AND status != 'completed' AND tags IS NOT NULL
  `).all(companyId);
  return rows.find((r) => r.tags.split(",").map((t) => t.trim()).includes("supervisor")) || null;
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

export function getWfHumanProjects() {
  return getDb().prepare(`
    SELECT p.id, p.name, p.updated_at,
           c.name AS company_name, d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE p.status = 'wfhuman'
    ORDER BY p.updated_at DESC
    LIMIT 25
  `).all();
}

export function getOpenInboxCount() {
  ensureInboxTable();
  const row = getDb().prepare(
    "SELECT COUNT(*) AS count FROM inbox_items WHERE status NOT IN ('done','dismissed')"
  ).get();
  return row.count;
}

export function getRecentInbox(n = 5) {
  ensureInboxTable();
  return getDb().prepare(`
    SELECT i.id, i.subject, i.client_hint, i.from_addr, i.priority, i.status, i.created_at,
           p.name AS project_name
    FROM inbox_items i
    LEFT JOIN projects p ON i.project_id = p.id
    WHERE i.status NOT IN ('done','dismissed')
    ORDER BY i.created_at DESC LIMIT ?
  `).all(n);
}

// ── OpenDia Agents (ODAs) ─────────────────────────────────────────────────────

export function ensureAgentsTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      slug                  TEXT NOT NULL UNIQUE,
      name                  TEXT NOT NULL,
      enabled               INTEGER NOT NULL DEFAULT 0,
      model                 TEXT NOT NULL DEFAULT 'opus',
      schedule_days         TEXT NOT NULL DEFAULT '1,2,3,4,5',
      schedule_start        TEXT NOT NULL DEFAULT '10:00',
      schedule_end          TEXT NOT NULL DEFAULT '13:00',
      heartbeat_minutes     INTEGER NOT NULL DEFAULT 60,
      heartbeat_token_limit INTEGER NOT NULL DEFAULT 200000,
      run_budget_usd        REAL NOT NULL DEFAULT 1.5,
      chat_webhook_url      TEXT,
      rotation_cursor       INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at     TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_projects (
      agent_id    INTEGER NOT NULL REFERENCES agents(id)   ON DELETE CASCADE,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id          TEXT PRIMARY KEY,
      agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      trigger     TEXT NOT NULL,
      status      TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd    REAL NOT NULL DEFAULT 0,
      summary     TEXT,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, started_at DESC);
    -- 2026-08-18: operator inbox acknowledgments. The inbox itself is
    -- DERIVED from the supervisor's agent_runs verdict ledger; the only
    -- state worth persisting is which items the operator has dismissed.
    -- key = "<agent_run_id>:<project_id>:<esc|ok>".
    CREATE TABLE IF NOT EXISTS operator_acks (
      key      TEXT PRIMARY KEY,
      acked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- 2026-08-20: Duties — named, reusable scope-of-work units attachable to
    -- one or more agents. The agent row keeps identity (persona, schedule,
    -- model, budgets); a duty carries the work: either a card-roster sweep
    -- (the config that used to live on the agent columns) or a recurring
    -- routine procedure aimed at a home card. slug is immutable — it is the
    -- filesystem path of the instruction file ~/OpenDia/duties/<slug>/duty.md.
    CREATE TABLE IF NOT EXISTS duties (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      slug                    TEXT NOT NULL UNIQUE,
      name                    TEXT NOT NULL,
      kind                    TEXT NOT NULL DEFAULT 'sweep',
      roster_mode             TEXT NOT NULL DEFAULT 'query',
      query_status            TEXT,
      query_next_step         TEXT NOT NULL DEFAULT 'any',
      query_client_only       INTEGER NOT NULL DEFAULT 0,
      triage                  INTEGER NOT NULL DEFAULT 0,
      max_cards_per_heartbeat INTEGER NOT NULL DEFAULT 1,
      target_project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      cadence_days            INTEGER NOT NULL DEFAULT 0,
      last_run_at             TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_duties (
      agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      duty_id     INTEGER NOT NULL REFERENCES duties(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL DEFAULT 0,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_id, duty_id)
    );
    -- 2026-09-02: session handoffs — messages an agent routes to the tmux
    -- session that owns a piece of work (git-hygiene nudges being the first
    -- writer). The server owns delivery: try now, retry from tick(), escalate
    -- to an operator_action when the target can't take it. finding_key is the
    -- dedupe handle ("git:<repo>|<session>|<kind>").
    CREATE TABLE IF NOT EXISTS handoffs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      finding_key     TEXT NOT NULL,
      target_session  TEXT NOT NULL,
      message         TEXT NOT NULL,
      source          TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_attempt_at TEXT,
      sent_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, created_at);
    -- 2026-09-02: one-click operator actions. Unlike operator_acks (which
    -- overlay a DERIVED inbox), these are first-class rows: an agent files a
    -- concrete executable action ('git_push') or an FYI ('notice') with full
    -- evidence, and the Operator inbox renders an Approve/Dismiss button.
    -- action is JSON ({repo, remote, branch, head_sha} for git_push).
    CREATE TABLE IF NOT EXISTS operator_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT,
      action      TEXT,
      source      TEXT,
      finding_key TEXT,
      status      TEXT NOT NULL DEFAULT 'open',
      result      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operator_actions_status ON operator_actions(status, created_at);
  `);
  // Migrate: query rosters + chat modes (added after the original agents schema).
  const cols = db.pragma("table_info(agents)").map((r) => r.name);
  if (!cols.includes("roster_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN roster_mode TEXT NOT NULL DEFAULT 'static'");
  }
  if (!cols.includes("query_status")) {
    db.exec("ALTER TABLE agents ADD COLUMN query_status TEXT");
  }
  if (!cols.includes("query_next_step")) {
    db.exec("ALTER TABLE agents ADD COLUMN query_next_step TEXT NOT NULL DEFAULT 'any'");
  }
  if (!cols.includes("max_cards_per_heartbeat")) {
    db.exec("ALTER TABLE agents ADD COLUMN max_cards_per_heartbeat INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.includes("chat_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN chat_mode TEXT NOT NULL DEFAULT 'per_heartbeat'");
  }
  if (!cols.includes("last_digest_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN last_digest_at TEXT");
  }
  // Supervisor role (added 2026-08): a supervisor reviews other agents' spark
  // runs instead of scanning cards. autopilot=0 is shadow mode — review and
  // escalate only, recording what would have been approved.
  if (!cols.includes("role")) {
    db.exec("ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'scanner'");
  }
  if (!cols.includes("min_certitude")) {
    db.exec("ALTER TABLE agents ADD COLUMN min_certitude INTEGER NOT NULL DEFAULT 70");
  }
  if (!cols.includes("max_auto_approvals")) {
    db.exec("ALTER TABLE agents ADD COLUMN max_auto_approvals INTEGER NOT NULL DEFAULT 5");
  }
  if (!cols.includes("autopilot")) {
    db.exec("ALTER TABLE agents ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0");
  }
  // Quick-win triage: a scanner with triage=1 runs a cheap model pass over
  // its full query-match list and only sparks confident picks.
  if (!cols.includes("triage")) {
    db.exec("ALTER TABLE agents ADD COLUMN triage INTEGER NOT NULL DEFAULT 0");
  }
  // Client-deliverable focus: query rosters keep only cards with a real
  // client Company set (not Linnflux-internal, not unassigned).
  if (!cols.includes("query_client_only")) {
    db.exec("ALTER TABLE agents ADD COLUMN query_client_only INTEGER NOT NULL DEFAULT 0");
  }
  // Duty rotation: which of the agent's duties the next heartbeat starts
  // from. Distinct from rotation_cursor (static-roster card rotation).
  if (!cols.includes("duty_cursor")) {
    db.exec("ALTER TABLE agents ADD COLUMN duty_cursor INTEGER NOT NULL DEFAULT 0");
  }
  // Per-duty run budget: a monthly audit is legitimately a bigger job than a
  // card scan. NULL = inherit the agent's run_budget_usd. (First audit run
  // proved this: 23 turns of clean work killed on the last tool call by the
  // agent's $1.50 card-scan ceiling.)
  const dutyCols = db.pragma("table_info(duties)").map((r) => r.name);
  if (!dutyCols.includes("run_budget_usd")) {
    db.exec("ALTER TABLE duties ADD COLUMN run_budget_usd REAL");
  }
}

const AGENT_UPDATABLE_FIELDS = new Set([
  "name", "enabled", "model", "schedule_days", "schedule_start", "schedule_end",
  "heartbeat_minutes", "heartbeat_token_limit", "run_budget_usd", "chat_webhook_url",
  "roster_mode", "query_status", "query_next_step", "max_cards_per_heartbeat", "chat_mode",
  "role", "min_certitude", "max_auto_approvals", "autopilot", "triage", "query_client_only",
]);

export function getAllAgents() {
  return getDb().prepare("SELECT * FROM agents ORDER BY name COLLATE NOCASE ASC").all();
}

export function getAgentById(id) {
  return getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

export function getAgentBySlug(slug) {
  return getDb().prepare("SELECT * FROM agents WHERE slug = ?").get(slug);
}

export function createAgent({ slug, name }) {
  const result = getDb().prepare(
    "INSERT INTO agents (slug, name) VALUES (?, ?)"
  ).run(slug, name);
  return getAgentById(result.lastInsertRowid);
}

export function updateAgent(id, fields) {
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(fields)) {
    if (!AGENT_UPDATABLE_FIELDS.has(key)) continue;
    sets.push(`${key} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) throw new Error("No valid fields to update");
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  return getDb().prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes > 0;
}

// Heartbeat bookkeeping writes bypass the admin-editable allowlist on purpose.
// last_heartbeat_at means "last SCHEDULED heartbeat": manual runs advance the
// rotation cursor but never defer the schedule — the schedule is a promise,
// and a manual run is extra work on top of it.
export function markAgentHeartbeat(id, rotationCursor, { touchHeartbeat = true } = {}) {
  if (touchHeartbeat) {
    getDb().prepare(
      "UPDATE agents SET last_heartbeat_at = datetime('now'), rotation_cursor = ? WHERE id = ?"
    ).run(rotationCursor, id);
  } else {
    getDb().prepare("UPDATE agents SET rotation_cursor = ? WHERE id = ?").run(rotationCursor, id);
  }
}

export function getAgentProjects(agentId) {
  return getDb().prepare(`
    SELECT p.id, p.name, p.status, p.next_step, p.tmux_session, p.notion_id,
           c.name AS company_name, c.short_name AS company_short, d.name AS division,
           ap.assigned_at
    FROM agent_projects ap
    JOIN projects p ON ap.project_id = p.id
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE ap.agent_id = ?
    ORDER BY ap.assigned_at ASC
  `).all(agentId);
}

// Query-roster source: same row shape as getAgentProjects so the executor and
// UI treat both modes identically. Date filtering happens in JS (agents.js) —
// the next_step date lives inside a text prefix, not a real column.
export function getProjectsByStatuses(statuses) {
  if (!statuses?.length) return [];
  const placeholders = statuses.map(() => "?").join(",");
  return getDb().prepare(`
    SELECT p.id, p.name, p.status, p.next_step, p.tmux_session, p.notion_id, p.updated_at,
           c.name AS company_name, c.short_name AS company_short, d.name AS division
    FROM projects p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN divisions d ON p.division_id = d.id
    WHERE p.status IN (${placeholders})
    ORDER BY p.updated_at ASC
  `).all(...statuses);
}

// Digest bookkeeping — not admin-editable, bypasses the allowlist on purpose.
export function markAgentDigest(id) {
  getDb().prepare("UPDATE agents SET last_digest_at = datetime('now') WHERE id = ?").run(id);
}

export function getAgentRunsSince(agentId, sinceUtc) {
  return getDb().prepare(`
    SELECT * FROM agent_runs
    WHERE agent_id = ? AND finished_at IS NOT NULL AND finished_at > COALESCE(?, '')
    ORDER BY started_at ASC
  `).all(agentId, sinceUtc);
}

export function getOperatorAckKeys() {
  return getDb().prepare("SELECT key FROM operator_acks").all().map((r) => r.key);
}

export function ackOperatorItems(keys) {
  const stmt = getDb().prepare("INSERT OR IGNORE INTO operator_acks (key) VALUES (?)");
  let n = 0;
  for (const k of keys) n += stmt.run(String(k)).changes;
  return n;
}

export function assignAgentProject(agentId, projectId) {
  return getDb().prepare(
    "INSERT OR IGNORE INTO agent_projects (agent_id, project_id) VALUES (?, ?)"
  ).run(agentId, projectId).changes > 0;
}

export function unassignAgentProject(agentId, projectId) {
  return getDb().prepare(
    "DELETE FROM agent_projects WHERE agent_id = ? AND project_id = ?"
  ).run(agentId, projectId).changes > 0;
}

// ── Duties ────────────────────────────────────────────────────────────────

const DUTY_UPDATABLE_FIELDS = new Set([
  "name", "kind", "roster_mode", "query_status", "query_next_step",
  "query_client_only", "triage", "max_cards_per_heartbeat",
  "target_project_id", "cadence_days", "run_budget_usd",
]);

export function getAllDuties() {
  const duties = getDb().prepare("SELECT * FROM duties ORDER BY name COLLATE NOCASE ASC").all();
  const bindings = getDb().prepare(`
    SELECT ad.duty_id, ad.position, a.id AS agent_id, a.slug, a.name
    FROM agent_duties ad JOIN agents a ON a.id = ad.agent_id
    ORDER BY ad.position ASC, ad.assigned_at ASC
  `).all();
  for (const d of duties) {
    d.agents = bindings.filter((b) => b.duty_id === d.id)
      .map((b) => ({ id: b.agent_id, slug: b.slug, name: b.name, position: b.position }));
  }
  return duties;
}

export function getDutyById(id) {
  return getDb().prepare("SELECT * FROM duties WHERE id = ?").get(id);
}

export function getDutyBySlug(slug) {
  return getDb().prepare("SELECT * FROM duties WHERE slug = ?").get(slug);
}

export function createDuty({ slug, name, kind = "sweep" }) {
  const info = getDb().prepare(
    "INSERT INTO duties (slug, name, kind) VALUES (?, ?, ?)"
  ).run(slug, name, kind);
  return getDutyById(info.lastInsertRowid);
}

export function updateDuty(id, fields) {
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(fields)) {
    if (!DUTY_UPDATABLE_FIELDS.has(key)) continue;
    sets.push(`${key} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) throw new Error("No valid fields to update");
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  return getDb().prepare(`UPDATE duties SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes > 0;
}

export function deleteDuty(id) {
  return getDb().prepare("DELETE FROM duties WHERE id = ?").run(id).changes > 0;
}

export function getAgentDuties(agentId) {
  return getDb().prepare(`
    SELECT d.*, ad.position FROM agent_duties ad
    JOIN duties d ON d.id = ad.duty_id
    WHERE ad.agent_id = ?
    ORDER BY ad.position ASC, ad.assigned_at ASC
  `).all(agentId);
}

export function assignDuty(agentId, dutyId, position = 0) {
  return getDb().prepare(
    "INSERT OR IGNORE INTO agent_duties (agent_id, duty_id, position) VALUES (?, ?, ?)"
  ).run(agentId, dutyId, position).changes > 0;
}

export function unassignDuty(agentId, dutyId) {
  return getDb().prepare(
    "DELETE FROM agent_duties WHERE agent_id = ? AND duty_id = ?"
  ).run(agentId, dutyId).changes > 0;
}

// Bookkeeping writes — deliberately outside the PATCH allowlist, like
// markAgentDigest.
export function markDutyRun(id) {
  getDb().prepare("UPDATE duties SET last_run_at = datetime('now') WHERE id = ?").run(id);
}

export function bumpDutyCursor(agentId, value) {
  getDb().prepare("UPDATE agents SET duty_cursor = ? WHERE id = ?").run(value, agentId);
}

// ── Session handoffs + operator actions ───────────────────────────────────

// Dedupe rules live here, not in the route: a pending row with the same
// finding_key absorbs the new message (the finding got fresher, the debt
// didn't multiply); a row already SENT within the last day suppresses a
// re-send outright (a re-run scan must not double-nudge the same session).
export function createHandoff({ findingKey, targetSession, message, source }) {
  const db = getDb();
  const pending = db.prepare(
    "SELECT * FROM handoffs WHERE finding_key = ? AND status = 'pending'"
  ).get(findingKey);
  if (pending) {
    db.prepare("UPDATE handoffs SET message = ?, target_session = ?, source = ? WHERE id = ?")
      .run(message, targetSession, source || null, pending.id);
    return { ...pending, message, target_session: targetSession, deduped: "updated-pending" };
  }
  const recentSent = db.prepare(
    "SELECT id FROM handoffs WHERE finding_key = ? AND status = 'sent' AND sent_at > datetime('now', '-1 day')"
  ).get(findingKey);
  if (recentSent) return { id: recentSent.id, deduped: "recently-sent" };
  const info = db.prepare(
    "INSERT INTO handoffs (finding_key, target_session, message, source) VALUES (?, ?, ?, ?)"
  ).run(findingKey, targetSession, message, source || null);
  return db.prepare("SELECT * FROM handoffs WHERE id = ?").get(info.lastInsertRowid);
}

export function getPendingHandoffs() {
  return getDb().prepare(
    "SELECT * FROM handoffs WHERE status = 'pending' ORDER BY created_at ASC"
  ).all();
}

export function recordHandoffAttempt(id, { status, error }) {
  getDb().prepare(`
    UPDATE handoffs SET status = ?, attempts = attempts + 1, last_error = ?,
      last_attempt_at = datetime('now'),
      sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END
    WHERE id = ?
  `).run(status, error || null, status, id);
}

export function createOperatorAction({ kind, title, body, action, source, findingKey }) {
  const db = getDb();
  if (findingKey) {
    const open = db.prepare(
      "SELECT id FROM operator_actions WHERE finding_key = ? AND status = 'open'"
    ).get(findingKey);
    if (open) {
      db.prepare("UPDATE operator_actions SET title = ?, body = ?, action = ?, source = ? WHERE id = ?")
        .run(title, body || null, action ? JSON.stringify(action) : null, source || null, open.id);
      return db.prepare("SELECT * FROM operator_actions WHERE id = ?").get(open.id);
    }
  }
  const info = db.prepare(`
    INSERT INTO operator_actions (kind, title, body, action, source, finding_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kind, title, body || null, action ? JSON.stringify(action) : null, source || null, findingKey || null);
  return db.prepare("SELECT * FROM operator_actions WHERE id = ?").get(info.lastInsertRowid);
}

export function getOperatorActionById(id) {
  return getDb().prepare("SELECT * FROM operator_actions WHERE id = ?").get(id);
}

export function listOpenOperatorActions() {
  return getDb().prepare(
    "SELECT * FROM operator_actions WHERE status = 'open' ORDER BY created_at DESC LIMIT 50"
  ).all();
}

export function resolveOperatorAction(id, status, result) {
  return getDb().prepare(`
    UPDATE operator_actions SET status = ?, result = ?, resolved_at = datetime('now')
    WHERE id = ? AND status = 'open'
  `).run(status, result || null, id).changes > 0;
}

export function insertAgentRun({ id, agentId, trigger, status, summary = null, detail = null }) {
  getDb().prepare(`
    INSERT INTO agent_runs (id, agent_id, trigger, status, started_at, summary, detail)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(id, agentId, trigger, status, summary, detail);
}

export function updateAgentRun(id, { status, tokensUsed, costUsd, summary, detail, finished }) {
  const sets = [];
  const vals = [];
  if (status !== undefined) { sets.push("status = ?"); vals.push(status); }
  if (tokensUsed !== undefined) { sets.push("tokens_used = ?"); vals.push(tokensUsed); }
  if (costUsd !== undefined) { sets.push("cost_usd = ?"); vals.push(costUsd); }
  if (summary !== undefined) { sets.push("summary = ?"); vals.push(summary); }
  if (detail !== undefined) { sets.push("detail = ?"); vals.push(detail); }
  if (finished) sets.push("finished_at = datetime('now')");
  if (sets.length === 0) return;
  vals.push(id);
  getDb().prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getAgentRuns(agentId, limit = 25) {
  return getDb().prepare(
    "SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?"
  ).all(agentId, limit);
}

// Dashboard restarted mid-heartbeat: the executor's in-memory state is gone,
// so any row still 'running' can never finish — close it out as interrupted.
export function interruptStaleAgentRuns() {
  return getDb().prepare(`
    UPDATE agent_runs SET status = 'interrupted', finished_at = datetime('now')
    WHERE status = 'running'
  `).run().changes;
}
