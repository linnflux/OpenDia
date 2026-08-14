// chat_notify.js — post a message to a Google Chat space via incoming webhook.
//
// The Google Chat MCP server is read-only, so agent notifications go through a
// plain webhook POST instead. Resolution order: the agent's own webhook URL,
// then AGENT_CHAT_WEBHOOK_URL from the environment. Unset means skip quietly —
// a missing webhook must never fail a heartbeat.

export async function notifyChat(url, text) {
  const target = url || process.env.AGENT_CHAT_WEBHOOK_URL || null;
  if (!target) {
    console.log("agents: chat webhook unset, skipping notify");
    return false;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) console.error(`agents: chat webhook returned ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error("agents: chat notify failed:", err.message);
    return false;
  }
}
