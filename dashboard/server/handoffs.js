import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { execFileSync, spawnSync } from "child_process";
import { requireAdmin } from "./auth.js";
import { deliver, MAX_SEND_CHARS } from "./session_gate.js";
import {
  createHandoff, getPendingHandoffs, recordHandoffAttempt,
  createOperatorAction, getOperatorActionById, listOpenOperatorActions,
  resolveOperatorAction,
} from "./db.js";

// handoffs.js — routing work to whoever owns it.
//
// Two primitives an agent (or any loopback caller) can file:
//
//   POST /api/handoffs           a message for the tmux session that owns a
//                                piece of work. The SERVER owns delivery:
//                                try now, retry from the agents tick, and
//                                escalate to an operator action when the
//                                session can't take it. The agent never
//                                touches tmux itself.
//   POST /api/operator-actions   a one-click item for the Operator inbox —
//                                either an executable 'git_push' (Approve
//                                runs the push server-side, deterministic,
//                                exactly the commits the evidence showed) or
//                                a 'notice' (Dismiss-only FYI).
//
// First writer: the git-hygiene duty. Nothing here is git-hygiene-specific
// except the git_push executor.

const HOME = process.env.HOME || "/home/linnflux";
const HANDOFFS_LOG = resolve(HOME, "OpenDia", "agents", "handoffs.log");

// Same shape discipline runrooms/mailroom apply to their path segments.
const SESSION_NAME_RE = /^[A-Za-z0-9_.@-]{1,40}$/;

const RETRY_MIN_MS = 10 * 60 * 1000;        // min gap between delivery attempts
const GIVE_UP_HOURS = 48;                   // then escalate to the inbox

// A pane whose foreground process is a plain shell is a session Claude has
// exited: the gate already refuses it (no input box), but it will also never
// open, so waiting 48h is theater. Checked before every attempt.
function paneCommand(tmuxSession) {
  try {
    return execFileSync(
      "tmux", ["display-message", "-p", "-t", tmuxSession, "#{pane_current_command}"],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null; // session gone
  }
}

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash"]);

function escalateHandoff(row, reason) {
  recordHandoffAttempt(row.id, { status: "escalated", error: reason });
  createOperatorAction({
    kind: "notice",
    title: `Undeliverable handoff for session "${row.target_session}" (${reason})`,
    body: `The message below could not be delivered — handle it yourself or re-open the session.\n\n${row.message}`,
    source: row.source,
    findingKey: `handoff-esc:${row.finding_key}`,
  });
}

// One delivery attempt. Returns the row's new status.
function attemptHandoff(row) {
  const cmd = paneCommand(row.target_session);
  if (cmd === null) { escalateHandoff(row, "session gone"); return "escalated"; }
  if (SHELLS.has(cmd)) { escalateHandoff(row, "Claude exited — bare shell pane"); return "escalated"; }
  const { status, body } = deliver({
    tmuxSession: row.target_session, logPath: HANDOFFS_LOG,
    text: row.message, user: null, tag: `handoff:${row.source || "?"}`,
  });
  if (status === 200) { recordHandoffAttempt(row.id, { status: "sent" }); return "sent"; }
  const reason = body?.gate?.reason || body?.error || `http ${status}`;
  if (reason === "session-gone") { escalateHandoff(row, "session gone"); return "escalated"; }
  recordHandoffAttempt(row.id, { status: "pending", error: reason });
  return "pending";
}

// Called from agents.js's tick() — the same external cron that drives
// heartbeats drives redelivery. Quiet on empty.
export function drainPendingHandoffs() {
  const now = Date.now();
  for (const row of getPendingHandoffs()) {
    const created = new Date(row.created_at.replace(" ", "T") + "Z").getTime();
    if (now - created > GIVE_UP_HOURS * 3600 * 1000) {
      escalateHandoff(row, `undelivered for ${GIVE_UP_HOURS}h`);
      continue;
    }
    const last = row.last_attempt_at
      ? new Date(row.last_attempt_at.replace(" ", "T") + "Z").getTime() : 0;
    if (now - last < RETRY_MIN_MS) continue;
    try { attemptHandoff(row); } catch (e) {
      recordHandoffAttempt(row.id, { status: "pending", error: e.message });
    }
  }
}

// ── The git_push executor ──────────────────────────────────────────────────
// Deterministic by design: what the operator approved is literally what runs.
// The HEAD-sha re-check is the whole safety story — if the repo moved after
// the scan, the evidence is stale and the click fails loudly instead of
// pushing commits nobody looked at. (Content safety is commit-time's job:
// the public repo's pre-commit guard has already gated everything here.)
function runGitPush(action) {
  const repo = String(action.repo || "");
  if (!repo.startsWith(HOME + "/") || repo.includes("..")) {
    throw new Error(`repo path outside home: ${repo}`);
  }
  if (!existsSync(repo) || !statSync(repo).isDirectory() || !existsSync(resolve(repo, ".git"))) {
    throw new Error(`not a git repo: ${repo}`);
  }
  const git = (args) => execFileSync("git", ["-C", repo, ...args],
    { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = git(["rev-parse", "HEAD"]);
  if (head !== action.head_sha) {
    throw new Error(`repo moved on since the scan (HEAD ${head.slice(0, 7)}, evidence ${String(action.head_sha).slice(0, 7)}) — re-scan before pushing`);
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== action.branch) {
    throw new Error(`branch changed since the scan (now ${branch}, evidence ${action.branch})`);
  }
  const remote = String(action.remote || "origin");
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(remote)) throw new Error(`bad remote name: ${remote}`);
  const r = spawnSync("git", ["-C", repo, "push", remote, branch],
    { encoding: "utf8", timeout: 120000 });
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  if (r.status !== 0) throw new Error(out || `git push exited ${r.status}`);
  return out || `pushed ${branch} to ${remote}`;
}

const ACTION_KINDS = new Set(["git_push", "notice"]);

export function registerHandoffRoutes(app) {
  // Loopback callers (agent scan sessions) arrive as an admin user via
  // auth.js, so requireAdmin covers both surfaces.
  app.post("/api/handoffs", requireAdmin, (req, res) => {
    const b = req.body || {};
    const target = String(b.target_session || "");
    if (!SESSION_NAME_RE.test(target)) return res.status(400).json({ error: "bad target_session" });
    let message = typeof b.message === "string" ? b.message : "";
    message = message.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
    if (!message) return res.status(400).json({ error: "empty message" });
    if (message.length > MAX_SEND_CHARS) return res.status(400).json({ error: `over ${MAX_SEND_CHARS} chars` });
    const findingKey = String(b.finding_key || "").slice(0, 300);
    if (!findingKey) return res.status(400).json({ error: "finding_key required" });
    try {
      const row = createHandoff({
        findingKey, targetSession: target, message,
        source: typeof b.source === "string" ? b.source.slice(0, 100) : null,
      });
      if (row.deduped === "recently-sent") {
        return res.json({ id: row.id, status: "deduped", detail: "same finding delivered within 24h" });
      }
      const status = attemptHandoff({ ...row, message, target_session: target });
      res.json({ id: row.id, status });
    } catch (err) {
      console.error("POST /api/handoffs error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator-actions", requireAdmin, (req, res) => {
    const b = req.body || {};
    if (!ACTION_KINDS.has(b.kind)) return res.status(400).json({ error: "kind must be git_push or notice" });
    const title = String(b.title || "").trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: "title required" });
    if (b.kind === "git_push") {
      const a = b.action || {};
      if (!a.repo || !a.branch || !a.head_sha) {
        return res.status(400).json({ error: "git_push action needs repo, branch, head_sha" });
      }
    }
    try {
      const row = createOperatorAction({
        kind: b.kind, title,
        body: typeof b.body === "string" ? b.body.slice(0, 8000) : null,
        action: b.kind === "git_push" ? b.action : null,
        source: typeof b.source === "string" ? b.source.slice(0, 100) : null,
        findingKey: typeof b.finding_key === "string" ? b.finding_key.slice(0, 300) : null,
      });
      res.json({ id: row.id, status: row.status });
    } catch (err) {
      console.error("POST /api/operator-actions error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator-actions/:id/approve", requireAdmin, (req, res) => {
    const row = getOperatorActionById(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.status !== "open") return res.status(409).json({ error: `already ${row.status}` });
    if (row.kind !== "git_push") return res.status(400).json({ error: "nothing to execute for this kind" });
    let action;
    try { action = JSON.parse(row.action || "null"); } catch { action = null; }
    if (!action) return res.status(500).json({ error: "malformed action payload" });
    try {
      const result = runGitPush(action);
      resolveOperatorAction(row.id, "done", result);
      res.json({ id: row.id, status: "done", result });
    } catch (err) {
      resolveOperatorAction(row.id, "failed", err.message);
      res.status(502).json({ id: row.id, status: "failed", result: err.message });
    }
  });

  app.post("/api/operator-actions/:id/dismiss", requireAdmin, (req, res) => {
    const row = getOperatorActionById(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.status !== "open") return res.status(409).json({ error: `already ${row.status}` });
    resolveOperatorAction(row.id, "dismissed", null);
    res.json({ id: row.id, status: "dismissed" });
  });
}

export { listOpenOperatorActions };
