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

async function notionFetch(path) {
  if (!notionToken) return null;
  const res = await fetch(`${NOTION_API}${path}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": NOTION_VERSION,
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
