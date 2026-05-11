import { readFileSync } from "fs";
import { resolve } from "path";

const CLAUDE_CREDS_PATH = resolve(
  process.env.HOME,
  ".claude",
  ".credentials.json"
);

function getAccessToken() {
  const creds = JSON.parse(readFileSync(CLAUDE_CREDS_PATH, "utf-8"));
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("No Claude OAuth token found");
  return oauth.accessToken;
}

/**
 * Analyze emails and project context to determine updates.
 * Returns { nextStep, changeRequests: [{ summary, detail }] }
 */
export async function analyzeSync({ project, emails, notion }) {
  const token = getAccessToken();

  const projectContext = [
    `Project: ${project.name}`,
    `Company: ${project.company_name || "unknown"}`,
    `Division: ${project.division || "unknown"}`,
    `Current status: ${project.status}`,
    project.next_step ? `Current next step: ${project.next_step}` : "No next step set",
    project.notes ? `Notes: ${project.notes}` : "",
  ].filter(Boolean).join("\n");

  const notionContext = notion
    ? [
        `Notion title: ${notion.title}`,
        notion.status ? `Notion status: ${notion.status}` : "",
        notion.todos?.length
          ? `Todos:\n${notion.todos.map((t) => `  [${t.checked ? "x" : " "}] ${t.text}`).join("\n")}`
          : "",
        notion.comments?.length
          ? `Recent comments:\n${notion.comments.map((c) => `  ${c.text} (${c.created})`).join("\n")}`
          : "",
      ].filter(Boolean).join("\n")
    : "No Notion page linked.";

  const emailContext = emails.length
    ? emails
        .map(
          (e) =>
            `From: ${e.from}\nDate: ${e.date}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`
        )
        .join("\n---\n")
    : "No recent emails found.";

  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const prompt = `You are a project management assistant for Linnflux, a web services company. Analyze the following project context, Notion task, and recent emails to determine:

1. Whether any emails contain new requests, change requests, or action items from the client
2. What the updated "next step" should be for this project (one concise sentence)

Today: ${today}

PROJECT:
${projectContext}

NOTION TASK:
${notionContext}

RECENT EMAILS:
${emailContext}

Respond in JSON only (no markdown fencing):
{
  "nextStep": "the recommended next step — if there is a clear by-when (external dependency, scheduled event, soft deadline), prepend YYYY-MM-DD: to the action text (e.g. '${nextWeek}: Follow up with client if no response'). Default for waiting-on-someone with no specific date: today +1 week (${nextWeek}). Skip the prefix for pure work-continuation items. Max 100 chars total.",
  "changeRequests": [
    {
      "summary": "one-line summary of the change/request",
      "detail": "brief detail of what was requested and by whom"
    }
  ],
  "reasoning": "1-2 sentence explanation of your analysis"
}

If there are no new action items or change requests in the emails, return an empty changeRequests array and set nextStep to the current next step (or a sensible one if none exists). Be concise.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Claude API error:", res.status, err);
    return null;
  }

  const data = await res.json();
  let text = data.content?.[0]?.text || "";

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  try {
    return JSON.parse(text);
  } catch {
    console.error("Failed to parse Claude response:", text);
    return null;
  }
}
