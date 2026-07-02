import { resolve } from "path";
import { spawn } from "child_process";

// Run a prompt through the claude CLI (same auth + pattern as the newsletter
// and sweep features). The previous direct-API approach sent the Claude Code
// OAuth token as x-api-key, which the API rejects with 401 — it never worked.
function runClaude(prompt, { model = "haiku", timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const claudeBin = resolve(process.env.HOME, ".local", "bin", "claude");
    const proc = spawn(claudeBin, [
      "-p", prompt,
      "--model", model,
      "--permission-mode", "bypassPermissions",
      "--output-format", "json",
    ], { cwd: resolve(process.env.HOME, "OpenDia") });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("claude CLI timed out"));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      try {
        const envelope = JSON.parse(stdout);
        resolvePromise((envelope.result || "").trim());
      } catch (err) {
        reject(new Error(`bad claude CLI output: ${err.message}`));
      }
    });
  });
}

/**
 * Review a project card against fresh evidence (Notion task, recent emails,
 * recent timer entries) and produce PROPOSALS — nothing here is applied;
 * the client renders each proposal with Apply/Dismiss buttons.
 * Returns { next_step, status, change_requests: [{ summary, detail }], summary }
 * where next_step/status are { value, reason } or null when no change is warranted.
 */
export async function analyzeReview({ project, emails, notion, timers }) {
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

  const timerContext = timers?.length
    ? timers
        .map(
          (t) =>
            `Start: ${t.start || "?"} (${t.duration || "running"})\nTask: ${t.task || ""}\nNotes: ${(t.notes || "").trim() || "(none)"}`
        )
        .join("\n---\n")
    : "No recent work sessions found.";

  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const prompt = `You are a project management assistant for Linnflux, a web services company. Review this project card against fresh evidence and PROPOSE updates. Your proposals are shown to the operator with Apply/Dismiss buttons — propose a change only when the evidence clearly warrants it; return null otherwise.

Today: ${today}

PROJECT CARD:
${projectContext}

NOTION TASK:
${notionContext}

RECENT WORK SESSIONS (newest first — the most recent "NEXT:" line in session notes is the strongest signal for the card's next step):
${timerContext}

RECENT EMAILS:
${emailContext}

Respond in JSON only (no markdown fencing):
{
  "next_step": { "value": "proposed next step — if there is a clear by-when (external dependency, scheduled event, soft deadline), prepend YYYY-MM-DD: to the action text (e.g. '${nextWeek}: Follow up with client if no response'). Default for waiting-on-someone with no specific date: today +1 week (${nextWeek}). Skip the prefix for pure work-continuation items. Max 100 chars total.", "reason": "why, citing the evidence" } or null if the current next step is still right,
  "status": { "value": "in_progress|wfhuman|completed|ice", "reason": "why, citing the evidence" } or null if the current status is still right,
  "change_requests": [
    {
      "summary": "one-line summary of a new client request found in the emails",
      "detail": "brief detail of what was requested and by whom"
    }
  ],
  "summary": "1-2 sentence overall read of where this card stands"
}

Rules:
- next_step: propose only if it should CHANGE (meaningfully different from the current one). null means "current is fine".
- status: propose only on clear evidence (e.g. Notion task marked Completed, work notes say delivered, or card says in_progress but everything is waiting on an external party). null means "current is fine".
- change_requests: only NEW requests/action items found in the emails; empty array if none.
- Be concise and concrete.`;

  let text;
  try {
    text = await runClaude(prompt, { model: "haiku" });
  } catch (err) {
    console.error("Claude CLI error:", err.message);
    return null;
  }

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  try {
    return JSON.parse(text);
  } catch {
    console.error("Failed to parse Claude response:", text);
    return null;
  }
}
