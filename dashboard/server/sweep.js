import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { spawn } from "child_process";

// Cached AI sweep review. Deterministic signals (past-due, stale, missing
// next_step) are computed client-side from the projects the app already has;
// this module only handles the AI judgment pass (quick wins, blocked,
// per-card suggestions), which is expensive and therefore cached on disk —
// same pattern as .deadline-alerts.json.
const SWEEP_FILE = resolve(process.env.HOME, "OpenDia", "Time", ".sweep-review.json");
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

export function readSweepCache() {
  try {
    const data = JSON.parse(readFileSync(SWEEP_FILE, "utf-8"));
    const generated = data.generated ? new Date(data.generated) : null;
    return {
      generated: data.generated || null,
      stale: !generated || Date.now() - generated.getTime() > STALE_MS,
      quick_wins: data.quick_wins || [],
      blocked: data.blocked || [],
      suggestions: data.suggestions || [],
    };
  } catch {
    return { generated: null, stale: true, quick_wins: [], blocked: [], suggestions: [] };
  }
}

function buildPrompt(cards) {
  return `You are reviewing active project cards from a small agency's project board. Classify them. Respond with ONLY a JSON object — no prose, no markdown fences.

Output shape:
{
  "quick_wins": [{ "id": <card id>, "reason": "<why this is fast to knock out>", "est_minutes": <int> }],
  "blocked":    [{ "id": <card id>, "reason": "<who/what it's waiting on, with dates if visible>" }],
  "suggestions":[{ "id": <card id>, "action": "<one concrete next action, under 100 chars, starts with a verb>" }]
}

Rules:
- quick_wins: cards a single person could plausibly finish or meaningfully advance in under ~20 minutes (a follow-up email, a config flip, a confirmation check). Use next_step text, notes, and staleness as evidence. Be selective — 3-8 entries, not everything.
- blocked: cards clearly waiting on an external party or event (status wfhuman is a hint, but read the next_step/notes — some wfhuman cards actually have an action available NOW; those belong in quick_wins instead).
- suggestions: one per card where you can infer a concrete next action — cover as many cards as you have real signal for; skip cards where you'd only be guessing.
- A card may appear in multiple lists. Use only ids from the input. est_minutes is a rough integer.
- If a card genuinely needs deeper analysis you may spawn a lightweight subagent to reason about it, but the card data provided is usually sufficient — prefer answering directly.

Cards (JSON):
${JSON.stringify(cards, null, 1)}`;
}

export function runSweep(projects) {
  const cards = projects.map((p) => ({
    id: p.id,
    name: p.name,
    company: p.company_short || p.company_name || null,
    division: p.division || null,
    status: p.status,
    next_step: p.next_step || null,
    notes: p.notes ? String(p.notes).slice(0, 500) : null,
    updated_at: p.updated_at,
    inbox_count: p.inbox_count || 0,
  }));
  const validIds = new Set(cards.map((c) => c.id));

  return new Promise((resolvePromise, reject) => {
    const claudeBin = resolve(process.env.HOME, ".local", "bin", "claude");
    // Pinned 2026-08-12: bypassPermissions means this never enters plan mode,
    // so an unpinned run silently inherits whatever the user-level model key
    // happens to be. Naming it makes the choice greppable and diffable.
    const proc = spawn(claudeBin, [
      "-p", buildPrompt(cards),
      "--model", "sonnet",
      "--permission-mode", "bypassPermissions",
      "--output-format", "json",
    ], { cwd: resolve(process.env.HOME, "OpenDia") });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("sweep timed out after 5 minutes"));
    }, RUN_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
      try {
        const envelope = JSON.parse(stdout);
        let text = (envelope.result || "").trim();
        // Tolerate markdown fences despite the prompt forbidding them
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenced) text = fenced[1].trim();
        const parsed = JSON.parse(text);

        // Keep only entries whose id exists in the input set
        const keep = (arr) => (Array.isArray(arr) ? arr.filter((e) => validIds.has(e?.id)) : []);
        const result = {
          generated: new Date().toISOString(),
          quick_wins: keep(parsed.quick_wins),
          blocked: keep(parsed.blocked),
          suggestions: keep(parsed.suggestions),
        };
        writeFileSync(SWEEP_FILE, JSON.stringify(result, null, 2));
        resolvePromise({ ...result, stale: false });
      } catch (err) {
        reject(new Error(`could not parse sweep output: ${err.message}`));
      }
    });
  });
}
