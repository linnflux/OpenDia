import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let notionToken = process.env.NOTION_TOKEN;

// 2026-08-05 MCP daemon migration moved secrets out of ~/.claude.json into
// ~/.mcp/<name>.env (KEY=VALUE lines, 0600) — read that first.
if (!notionToken) {
  try {
    const envFile = readFileSync(resolve(process.env.HOME, ".mcp", "notion.env"), "utf-8");
    for (const line of envFile.split("\n")) {
      const [k, ...rest] = line.trim().split("=");
      if (k === "NOTION_TOKEN" && rest.length) {
        notionToken = rest.join("=");
        break;
      }
    }
  } catch {
    // silently ignore
  }
}

// Legacy fallback: pre-migration stdio MCP config
if (!notionToken) {
  try {
    const claudeConfig = JSON.parse(
      readFileSync(resolve(process.env.HOME, ".claude.json"), "utf-8")
    );
    notionToken = claudeConfig?.mcpServers?.notion?.env?.NOTION_TOKEN;
  } catch {
    // silently ignore
  }
}

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function notionFetch(path, options = {}) {
  if (!notionToken) return null;
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": NOTION_VERSION,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) return null;
  return res.json();
}

function extractTitle(page) {
  const props = page.properties || {};
  for (const val of Object.values(props)) {
    if (val.type === "title" && val.title?.length > 0) {
      return val.title.map((t) => t.plain_text).join("");
    }
  }
  return null;
}

function extractStatus(page) {
  const props = page.properties || {};
  for (const [key, val] of Object.entries(props)) {
    if (val.type === "status" && val.status) {
      return val.status.name;
    }
  }
  return null;
}

function extractDate(page) {
  const props = page.properties || {};
  for (const [key, val] of Object.entries(props)) {
    if (val.type === "date" && val.date) {
      return val.date;
    }
  }
  return null;
}

/**
 * Check if a Notion page title is a reasonable match for a query.
 * Requires at least half the significant words (3+ chars) from the query
 * to appear in the title, with a minimum of 2 matching words
 * (or 1 if the query only has 1 significant word).
 */
function titleMatchesQuery(title, query) {
  if (!title || !query) return false;
  const titleLower = title.toLowerCase();
  const NOISE = new Set(["the", "and", "for", "with", "from", "website", "site", "project", "app"]);
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !NOISE.has(w));
  if (queryWords.length === 0) return false;
  const matches = queryWords.filter((w) => titleLower.includes(w)).length;
  const threshold = Math.max(1, Math.ceil(queryWords.length / 2));
  return matches >= threshold;
}

/**
 * Search Notion for a page matching the project name or company name.
 * Validates that the returned page title actually relates to the query.
 * Returns the first matching page ID or null.
 */
export async function searchNotionForProject(projectName, companyName) {
  if (!notionToken) return null;

  // Skip company-name fallback for internal/generic names
  const SKIP_COMPANY = new Set(["linnflux"]);
  const queries = [projectName];
  if (companyName && !SKIP_COMPANY.has(companyName.toLowerCase())) {
    queries.push(companyName);
  }

  for (const query of queries.filter(Boolean)) {
    const data = await notionFetch("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        filter: { value: "page", property: "object" },
        page_size: 5,
      }),
    });
    if (!data?.results?.length) continue;

    // Validate: the page title must actually contain query terms
    for (const page of data.results) {
      const title = extractTitle(page);
      if (titleMatchesQuery(title, query)) {
        return page.id;
      }
    }
  }

  return null;
}

/**
 * Fetch just the title of a Notion page (lightweight).
 */
export async function fetchNotionTitle(notionId) {
  if (!notionToken || !notionId) return null;
  const page = await notionFetch(`/pages/${notionId}`);
  if (!page) return null;
  return extractTitle(page);
}

/**
 * Update a Notion Tasks-DB page's Due Date.
 * dateValue: { start: "ISO or YYYY-MM-DD", end: same | null }
 */
export async function updateNotionTaskDueDate(pageId, dateValue) {
  if (!notionToken || !pageId || !dateValue?.start) return false;
  const payload = { start: dateValue.start };
  if (dateValue.end) payload.end = dateValue.end;
  const res = await notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { "Due Date": { date: payload } },
    }),
  });
  return res !== null;
}

/**
 * Update a Notion Tasks-DB page's Status select field.
 * Returns true on success, false on failure or missing token.
 */
export async function updateNotionTaskStatus(pageId, statusName) {
  if (!notionToken || !pageId || !statusName) return false;
  const res = await notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { Status: { select: { name: statusName } } },
    }),
  });
  return res !== null;
}

// Tasks DB + operator map, mirrored from the /od-new CLI skill (Step 7) so a
// task created from the dashboard is indistinguishable from one created in a
// terminal. Unknown requesters (incl. loopback) attribute to Nick.
const NOTION_TASKS_DB = "aff52e96-1dfd-438c-8b15-84c446afd054";
const NOTION_USER_BY_EMAIL = {
  "nick@linnflux.com": "d6fcd91b-74b8-4514-ac84-08d8d7112d57",
  "tara.armstrong@linnflux.com": "9448b064-2474-425d-8723-c2421979d3fb",
};

/**
 * Create a task page in the Notion Tasks DB.
 * Returns { id, url } on success, null on failure or missing token.
 */
export async function createNotionTask({ name, division, companyNotionId, requesterEmail, dueISO }) {
  if (!notionToken || !name) return null;
  const properties = {
    Name: { title: [{ text: { content: name } }] },
    Status: { select: { name: "Open" } },
    Responsible: {
      people: [{ id: NOTION_USER_BY_EMAIL[requesterEmail] || NOTION_USER_BY_EMAIL["nick@linnflux.com"] }],
    },
  };
  if (division) properties.Type = { multi_select: [{ name: division }] };
  if (dueISO) properties["Due Date"] = { date: { start: dueISO } };
  if (companyNotionId) properties.Company = { relation: [{ id: companyNotionId }] };
  const res = await notionFetch("/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent: { database_id: NOTION_TASKS_DB }, properties }),
  });
  if (!res?.id) return null;
  return { id: res.id, url: res.url || `https://www.notion.so/${res.id.replace(/-/g, "")}` };
}

/**
 * Fetch a Notion page and extract useful info for a project refresh.
 */
export async function fetchNotionPage(notionId) {
  if (!notionToken || !notionId) return null;

  const page = await notionFetch(`/pages/${notionId}`);
  if (!page) return null;

  // Get child blocks for checklist items
  const blocks = await notionFetch(`/blocks/${notionId}/children?page_size=100`);
  const todos = [];
  if (blocks?.results) {
    for (const block of blocks.results) {
      if (block.type === "to_do") {
        const text = block.to_do.rich_text?.map((t) => t.plain_text).join("") || "";
        todos.push({ text, checked: block.to_do.checked });
      }
    }
  }

  // Get recent comments
  let comments = [];
  try {
    const commentsRes = await notionFetch(`/comments?block_id=${notionId}&page_size=5`);
    if (commentsRes?.results) {
      comments = commentsRes.results.map((c) => ({
        text: c.rich_text?.map((t) => t.plain_text).join("") || "",
        created: c.created_time,
      }));
    }
  } catch {
    // comments API may not be available
  }

  return {
    title: extractTitle(page),
    status: extractStatus(page),
    date: extractDate(page),
    last_edited: page.last_edited_time,
    todos,
    comments,
    url: `https://www.notion.so/${notionId.replace(/-/g, "")}`,
  };
}

/**
 * Collect all "YYYY-MM-DD HH:MM" markers from existing toggle blocks on a Notion page.
 * Used by /od-stop backfill to dedupe entries already logged. Paginates through all
 * children.
 */
export async function getTimerMarkers(notionId) {
  if (!notionToken || !notionId) return new Set();

  const markers = new Set();
  let startCursor = null;
  let hasMore = true;

  while (hasMore) {
    const qs = startCursor
      ? `?page_size=100&start_cursor=${encodeURIComponent(startCursor)}`
      : "?page_size=100";
    const data = await notionFetch(`/blocks/${notionId}/children${qs}`);
    if (!data) break;

    for (const block of data.results || []) {
      if (block.type !== "toggle") continue;
      const text = block.toggle.rich_text?.map((t) => t.plain_text).join("") || "";
      // Titles start with "YYYY-MM-DD HH:MM — ..."
      const match = text.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
      if (match) markers.add(match[1]);
    }

    hasMore = data.has_more || false;
    startCursor = data.next_cursor;
  }

  return markers;
}

/**
 * Append a single timer entry to a Notion task as a toggle block.
 *
 * Title format: "YYYY-MM-DD HH:MM — Task Title (1h 30m)" (the start-time prefix
 * serves as a dedupe marker when backfilling).
 *
 * Each line in the entry's notes becomes a bulleted_list_item child. Lines
 * starting with "NEXT:" are rendered in bold so they stand out in the toggle.
 */
export async function appendTimerLog(notionId, entry) {
  if (!notionToken || !notionId || !entry?.start) {
    return { logged: false, reason: "missing_input" };
  }

  const marker = entry.start.replace("T", " "); // "2026-04-08 09:00"
  const taskTitle = (entry.task || "(no task)").trim();
  const durationStr = entry.duration ? ` (${entry.duration})` : "";
  const title = `${marker} — ${taskTitle}${durationStr}`;

  const noteLines = (entry.notes || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const children = noteLines.length
    ? noteLines.map((line) => {
        const isNext = /^NEXT:/i.test(line);
        return {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [
              {
                type: "text",
                text: { content: line },
                annotations: isNext ? { bold: true } : {},
              },
            ],
          },
        };
      })
    : [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: "(no notes)" },
                annotations: { italic: true, color: "gray" },
              },
            ],
          },
        },
      ];

  const block = {
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: [
        {
          type: "text",
          text: { content: title },
          annotations: { bold: true },
        },
      ],
      children,
    },
  };

  const res = await notionFetch(`/blocks/${notionId}/children`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ children: [block] }),
  });

  return res ? { logged: true, marker } : { logged: false, reason: "api_error" };
}

/**
 * Prepend toggle blocks (with date headings) to a Notion page for change requests.
 * Each request becomes a toggle with the date as the heading and detail inside.
 */
export async function appendToggleBlocks(notionId, changeRequests) {
  if (!notionToken || !notionId || !changeRequests?.length) return;

  const today = new Date().toISOString().slice(0, 10);
  const children = changeRequests.map((cr) => ({
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: [
        {
          type: "text",
          text: { content: `${today} — ${cr.summary}` },
          annotations: { bold: true },
        },
      ],
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: cr.detail } },
            ],
          },
        },
      ],
    },
  }));

  // Get existing children to prepend (Notion API only appends, so we
  // fetch existing blocks, append our new ones first, then re-append old ones)
  // Actually, Notion's PATCH /blocks/{id}/children always appends at the end.
  // To prepend, we'd need to delete and recreate — too destructive.
  // Instead, we'll just append with a clear date marker. The toggle format
  // makes it scannable regardless of position.
  return notionFetch(`/blocks/${notionId}/children`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ children }),
  });
}
