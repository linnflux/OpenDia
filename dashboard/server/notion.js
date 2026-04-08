import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let notionToken = process.env.NOTION_TOKEN;

// Try to read from Claude's MCP config if not in env
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
