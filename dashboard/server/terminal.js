import { WebSocketServer } from "ws";
import pty from "node-pty";
import { spawnSync } from "child_process";
import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, appendFileSync, readdirSync, unlinkSync
} from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getProjectById } from "./db.js";
import { verifyRequest } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || "/home/linnflux";
const TIMER_DIR = `${HOME}/OpenDia/Time`;
const AUDIT_LOG = resolve(__dirname, "terminal-audit.log");

const SCROLLBACK_MAX = 65536;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_WARN_MS = 4 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
const GRACE_MS = 60_000;

// Map<String(projectId), SessionState>
const sessions = new Map();

function auditLog(event, projectId, session, ip = "", user = "") {
  const line = `${new Date().toISOString()} ${event} project_id=${projectId} session=${session} user=${user} ip=${ip}\n`;
  try { appendFileSync(AUDIT_LOG, line); } catch {}
}

function setTimerAttribution(session, fields) {
  const t = findTimerForSession(session);
  if (!t) return;
  if (fields.started_by && t.data.started_by) delete fields.started_by;
  Object.assign(t.data, fields);
  try { writeFileSync(t.file, JSON.stringify(t.data, null, 2)); } catch {}
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(state, msg) {
  const text = JSON.stringify(msg);
  for (const ws of state.subs) {
    if (ws.readyState === 1) ws.send(text);
  }
}

function broadcastState(state) {
  for (const ws of state.subs) {
    if (ws.readyState !== 1) continue;
    const isHolder = state.holder?.ws === ws;
    ws.send(JSON.stringify({
      type: "state",
      mode: isHolder ? "interactive" : (state.holder ? "locked-by-other" : "watching"),
      controlHolder: state.holder
        ? { takenAt: state.holder.takenAt, idleSec: Math.floor((Date.now() - state.holder.lastInputAt) / 1000), startedBy: state.holder.startedBy }
        : null
    }));
  }
}

function tmuxAlive(session) {
  return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

function forceRedraw(state) {
  // Make tmux size to the active client (us), not the smallest of all clients.
  // Idempotent — safe to call repeatedly.
  spawnSync("tmux", ["set-window-option", "-t", state.session, "aggressive-resize", "on"], { stdio: "ignore" });
  spawnSync("tmux", ["refresh-client", "-t", state.session], { stdio: "ignore" });
  // Resize-nudge our pty so tmux pushes a fresh frame.
  if (state.pty) {
    try {
      state.pty.resize(state.cols, Math.max(1, state.rows - 1));
      setTimeout(() => { try { state.pty?.resize(state.cols, state.rows); } catch {} }, 40);
    } catch {}
  }
}

function spawnPty(state, readOnly) {
  if (!tmuxAlive(state.session)) {
    state.sessionDead = true;
    broadcast(state, {
      type: "error",
      message: `tmux session '${state.session}' not found — start it and click Retry.`,
      fatal: true
    });
    return false;
  }
  state.sessionDead = false;

  const args = readOnly
    ? ["attach-session", "-r", "-t", state.session]
    : ["attach-session", "-t", state.session];

  try {
    const p = pty.spawn("tmux", args, {
      name: "xterm-256color",
      cols: state.cols || 220,
      rows: state.rows || 50,
      cwd: HOME,
      env: { ...process.env, TERM: "xterm-256color" }
    });

    p.onData((data) => {
      if (state.pty !== p) return;
      state.scrollback += data;
      if (state.scrollback.length > SCROLLBACK_MAX) {
        state.scrollback = state.scrollback.slice(-SCROLLBACK_MAX);
      }
      broadcast(state, { type: "output", data });
    });

    p.onExit(({ exitCode }) => {
      if (state.pty !== p) return;
      state.pty = null;
      state.ptyReadOnly = true;
      if (state.holder) {
        state.holder = null;
        broadcastState(state);
      }
      // Don't respawn if the session is gone — stops the retry loop
      if (!tmuxAlive(state.session)) {
        state.sessionDead = true;
        broadcast(state, {
          type: "error",
          message: `tmux session '${state.session}' ended — click Retry if you restart it.`,
          fatal: true
        });
        return;
      }
      broadcast(state, { type: "error", message: `tmux session '${state.session}' ended (exit ${exitCode})` });
      // Respawn as watch-only if there are still viewers
      if (state.subs.size > 0) {
        setTimeout(() => {
          if (!state.pty && state.subs.size > 0) spawnPty(state, true);
        }, 1000);
      }
    });

    state.pty = p;
    state.ptyReadOnly = readOnly;
    setTimeout(() => { if (state.pty === p) forceRedraw(state); }, 250);
    return true;
  } catch (err) {
    broadcast(state, { type: "error", message: `Failed to attach to tmux: ${err.message}` });
    return false;
  }
}

function killPty(state) {
  if (state.pty) {
    try { state.pty.kill(); } catch {}
    state.pty = null;
    state.ptyReadOnly = true;
  }
}

function releaseControl(state, projectId, user = "") {
  if (!state.holder) return;
  const { session } = state;
  state.holder = null;
  auditLog("release", projectId, session, "", user);
  killPty(state);
  if (state.subs.size > 0) {
    setTimeout(() => {
      if (!state.pty && state.subs.size > 0) spawnPty(state, true);
    }, 200);
  }
  broadcastState(state);
}

// ── Timer helpers ──────────────────────────────────────────────────────────

function etNow() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const h = parts.hour === "24" ? "00" : parts.hour;
  return {
    YYYY: parts.year,
    MM: parts.month,
    DD: parts.day,
    HH: h,
    mm: parts.minute,
    iso: `${parts.year}-${parts.month}-${parts.day}T${h}:${parts.minute}`
  };
}

function durationStr(startIso, endIso) {
  const pad = s => s.length === 16 ? s + ":00" : s;
  const diffMin = Math.max(1, Math.round((new Date(pad(endIso)) - new Date(pad(startIso))) / 60000));
  if (diffMin < 60) return `${diffMin}m`;
  const h = Math.floor(diffMin / 60), m = diffMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function findTimerForSession(session) {
  try {
    for (const f of readdirSync(TIMER_DIR)) {
      if (!f.startsWith(".timer-") || !f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(`${TIMER_DIR}/${f}`, "utf8"));
        if (data.tmux_session === session) return { file: `${TIMER_DIR}/${f}`, data };
      } catch {}
    }
  } catch {}
  return null;
}

function startTimerForProject(project, taskOverride) {
  const t = etNow();
  const task = taskOverride || project.next_step || `${project.name} — dashboard terminal session`;
  const billable = !["Admin", "Onboarding"].includes(project.division);
  const marker = t.iso;

  const yearDir = `${TIMER_DIR}/${t.YYYY}/${t.MM}`;
  mkdirSync(yearDir, { recursive: true });
  const dailyFile = `${yearDir}/${t.YYYY}-${t.MM}-${t.DD}.md`;

  if (!existsSync(dailyFile)) {
    writeFileSync(dailyFile, `# Time Entries - ${t.YYYY}-${t.MM}-${t.DD}\n`);
  }

  appendFileSync(dailyFile, [
    ``,
    `---`,
    `<!-- entry:${marker} -->`,
    `client: ${project.company_name || project.name}`,
    `project: ${project.name}`,
    `division: ${project.division || ""}`,
    `task: ${task}`,
    `estimated_minutes: 30`,
    `start: ${marker}`,
    `end:`,
    `duration:`,
    `billable: ${billable}`,
    `notes:`,
    `---`,
    ``
  ].join("\n"));

  const stateFile = `${TIMER_DIR}/.timer-${marker.replace(/:/g, "-")}.json`;
  writeFileSync(stateFile, JSON.stringify({
    client: project.company_name || project.name,
    project: project.name,
    division: project.division || "",
    task,
    billable,
    start: marker,
    file: dailyFile,
    marker,
    tmux_session: project.tmux_session || "",
    project_id: project.id
  }, null, 2));

  return { stateFile, marker, dailyFile };
}

function closeTimerEntry(dailyFile, marker, endIso, notes) {
  const duration = durationStr(marker, endIso);
  let content = readFileSync(dailyFile, "utf8");
  const anchor = `<!-- entry:${marker} -->`;
  const idx = content.indexOf(anchor);
  if (idx === -1) return false;

  const sectionEnd = content.indexOf("\n---", idx + anchor.length);
  let section = content.slice(idx, sectionEnd);

  section = section
    .replace(/\nend:\n/, `\nend: ${endIso}\n`)
    .replace(/\nduration:\n/, `\nduration: ${duration}\n`);

  if (notes) {
    const indented = notes.split("\n").map(l => `  ${l}`).join("\n");
    section = section.replace(/\nnotes:\n/, `\nnotes: |\n${indented}\n`);
  }

  writeFileSync(dailyFile, content.slice(0, idx) + section + content.slice(sectionEnd));
  return true;
}

function pollForStateFileDeletion(stateFile, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const iv = setInterval(() => {
      if (!existsSync(stateFile)) { clearInterval(iv); resolve(); }
      else if (Date.now() > deadline) { clearInterval(iv); reject(new Error("timeout")); }
    }, 2000);
  });
}

// ── mountTerminal export ───────────────────────────────────────────────────

export function mountTerminal(server, app) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const m = req.url?.match(/^\/api\/projects\/(\d+)\/terminal$/);
    if (!m) { socket.destroy(); return; }
    const auth = verifyRequest(req);
    if (!auth.ok) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const wsProject = getProjectById(Number(m[1]));
    if (wsProject?.tmux_session === "operator" && !auth.is_admin) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, m[1]);
    });
  });

  wss.on("connection", (ws, req, projectId) => {
    const project = getProjectById(Number(projectId));
    if (!project?.tmux_session) {
      send(ws, { type: "error", message: "No tmux session configured for this project." });
      ws.close();
      return;
    }

    let state = sessions.get(projectId);
    if (!state) {
      state = {
        session: project.tmux_session,
        pty: null,
        ptyReadOnly: true,
        subs: new Set(),
        holder: null,
        scrollback: "",
        cols: 220,
        rows: 50,
        refCount: 0,
        idleInterval: null,
        graceTimer: null,
        sessionDead: false
      };
      sessions.set(projectId, state);
    }

    if (state.graceTimer) { clearTimeout(state.graceTimer); state.graceTimer = null; }

    state.refCount++;
    state.subs.add(ws);

    if (state.sessionDead) {
      // Session was already found dead — tell this subscriber immediately instead of spawning
      send(ws, {
        type: "error",
        message: `tmux session '${state.session}' not found — start it and click Retry.`,
        fatal: true
      });
    } else if (!state.pty) {
      spawnPty(state, true);
    }

    // Idle checker
    if (!state.idleInterval) {
      state.idleInterval = setInterval(() => {
        if (!state.holder) return;
        const idle = Date.now() - state.holder.lastInputAt;
        if (idle >= IDLE_TIMEOUT_MS) {
          broadcast(state, { type: "error", message: "Interactive control auto-released: 5 min idle." });
          releaseControl(state, projectId);
        } else if (idle >= IDLE_WARN_MS) {
          const left = Math.ceil((IDLE_TIMEOUT_MS - idle) / 1000);
          if (left <= 60 && idle % 15000 < 5500) {
            broadcast(state, { type: "idle_warning", secondsLeft: left });
          }
        }
      }, 5000);
    }

    // Send scrollback + initial state
    if (state.scrollback) send(ws, { type: "scrollback", data: state.scrollback });
    const isHolder = state.holder?.ws === ws;
    send(ws, {
      type: "state",
      mode: isHolder ? "interactive" : (state.holder ? "locked-by-other" : "watching"),
      controlHolder: state.holder
        ? { takenAt: state.holder.takenAt, idleSec: Math.floor((Date.now() - state.holder.lastInputAt) / 1000) }
        : null
    });

    // Heartbeat
    let alive = true;
    const pingIv = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      if (ws.readyState === 1) send(ws, { type: "ping" });
    }, HEARTBEAT_MS);

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case "pong": alive = true; break;
        case "ping": send(ws, { type: "pong" }); break;

        case "claim-control":
          if (state.holder && (state.holder.ws === null || state.holder.ws === ws)) {
            state.holder.ws = ws;
            send(ws, {
              type: "state",
              mode: "interactive",
              controlHolder: { takenAt: state.holder.takenAt, idleSec: 0 }
            });
          }
          break;

        case "input":
          if (state.holder?.ws !== ws) return;
          if (state.pty && !state.ptyReadOnly) {
            state.pty.write(msg.data);
            state.holder.lastInputAt = Date.now();
          }
          break;

        case "resize": {
          const cols = Math.max(10, Math.min(500, Number(msg.cols) || 80));
          const rows = Math.max(4, Math.min(200, Number(msg.rows) || 24));
          state.cols = cols;
          state.rows = rows;
          if (state.pty) try { state.pty.resize(cols, rows); } catch {}
          break;
        }

        case "retry":
          if (!state.pty) spawnPty(state, true);
          break;
      }
    });

    ws.on("close", () => {
      clearInterval(pingIv);
      state.subs.delete(ws);
      state.refCount = Math.max(0, state.refCount - 1);

      if (state.holder?.ws === ws) {
        broadcast(state, { type: "state", mode: "watching", controlHolder: null });
        releaseControl(state, projectId);
      }

      if (state.refCount === 0) {
        state.graceTimer = setTimeout(() => {
          if (state.refCount === 0) {
            killPty(state);
            if (state.idleInterval) { clearInterval(state.idleInterval); state.idleInterval = null; }
            sessions.delete(projectId);
          }
        }, GRACE_MS);
      }
    });
  });

  // GET /api/projects/:id/terminal/status
  app.get("/api/projects/:id/terminal/status", (req, res) => {
    const project = getProjectById(Number(req.params.id));
    if (!project) return res.status(404).json({ error: "not found" });
    const { tmux_session: session } = project;
    if (!session) return res.json({ session: null, alive: false, watchers: 0, controlHolder: null });
    const state = sessions.get(req.params.id);
    res.json({
      session,
      alive: tmuxAlive(session),
      watchers: state?.refCount ?? 0,
      controlHolder: state?.holder
        ? { takenAt: state.holder.takenAt, idleSec: Math.floor((Date.now() - state.holder.lastInputAt) / 1000), startedBy: state.holder.startedBy }
        : null
    });
  });

  // POST /api/projects/:id/terminal/take-control
  app.post("/api/projects/:id/terminal/take-control", (req, res) => {
    const { task } = req.body || {};
    const { id: projectId } = req.params;
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";

    const project = getProjectById(Number(projectId));
    if (!project) return res.status(404).json({ error: "not found" });
    if (!project.tmux_session) return res.status(400).json({ error: "no tmux session" });

    const state = sessions.get(projectId);
    if (!state) return res.status(400).json({ error: "no active viewer — open the Terminal tab first" });
    if (state.holder) return res.status(409).json({ error: "already controlled", controlHolder: { takenAt: state.holder.takenAt } });

    if (project.tmux_session === "operator" && !req.user?.is_admin) {
      return res.status(403).json({ error: "forbidden", reason: "admin_only" });
    }

    // Start timer if not running. The operator session is dispatch-only:
    // it must never have a timer, so take-control proceeds timer-free.
    let timerInfo = findTimerForSession(project.tmux_session);
    let timerStarted = false;
    if (!timerInfo && project.tmux_session !== "operator") {
      try {
        const info = startTimerForProject(project, task || undefined);
        timerInfo = { file: info.stateFile, data: info };
        timerStarted = true;
      } catch (err) {
        return res.status(500).json({ error: `timer start failed: ${err.message}` });
      }
    }

    // Upgrade pty to read-write (kills watchPty, spawns controlPty)
    killPty(state);
    const ok = spawnPty(state, false);
    if (!ok) {
      // Restore watch mode
      spawnPty(state, true);
      return res.status(500).json({ error: "failed to spawn interactive pty" });
    }

    const user = req.headers["tailscale-user-login"] || "";
    state.holder = {
      ws: null, // filled by "claim-control" WS message
      takenAt: Date.now(),
      lastInputAt: Date.now(),
      stateFile: timerInfo?.file ?? null,
      startedBy: user
    };

    setTimerAttribution(project.tmux_session, { started_by: user });
    auditLog("take", projectId, project.tmux_session, ip, user);
    broadcastState(state);
    res.json({ ok: true, timerStarted, session: project.tmux_session });
  });

  // POST /api/projects/:id/terminal/release-control
  // POST /api/projects/:id/terminal/redraw  (force a tmux redraw — fixes multi-client artifacting)
  app.post("/api/projects/:id/terminal/redraw", (req, res) => {
    const { id: projectId } = req.params;
    const state = sessions.get(projectId);
    if (!state) return res.status(400).json({ error: "no active viewer" });
    forceRedraw(state);
    res.json({ ok: true });
  });

  app.post("/api/projects/:id/terminal/release-control", (req, res) => {
    const { id: projectId } = req.params;
    const user = req.headers["tailscale-user-login"] || "";
    const state = sessions.get(projectId);
    if (!state?.holder) return res.json({ ok: true });
    const { session } = state;
    setTimerAttribution(session, { ended_by: user });
    releaseControl(state, projectId, user);
    res.json({ ok: true, endedBy: user });
  });

  // POST /api/projects/:id/terminal/send-od-stop
  app.post("/api/projects/:id/terminal/send-od-stop", async (req, res) => {
    const { id: projectId } = req.params;
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";
    const project = getProjectById(Number(projectId));
    if (!project) return res.status(404).json({ error: "not found" });
    const { tmux_session: session } = project;
    if (!session) return res.status(400).json({ error: "no tmux session" });

    const timerInfo = findTimerForSession(session);
    if (!timerInfo) return res.status(400).json({ error: "no running timer for this session" });

    const user = req.headers["tailscale-user-login"] || "";
    setTimerAttribution(session, { ended_by: user });
    spawnSync("tmux", ["send-keys", "-t", session, "/od-stop", "Enter"], { stdio: "ignore" });
    auditLog("od-stop-sent", projectId, session, ip, user);

    const state = sessions.get(projectId);
    if (state) broadcast(state, { type: "stop_in_progress" });

    try {
      await pollForStateFileDeletion(timerInfo.file, 180_000);
      if (state?.holder) releaseControl(state, projectId, user);
      else if (state) broadcastState(state);
      auditLog("od-stop-complete", projectId, session, ip, user);
      res.json({ ok: true });
    } catch {
      res.json({ ok: false, fallback: true, stateFile: timerInfo.file, message: "od-stop timed out — use fallback" });
    }
  });

  // POST /api/projects/:id/terminal/stop-local  (fallback when /od-stop times out)
  app.post("/api/projects/:id/terminal/stop-local", (req, res) => {
    const { id: projectId } = req.params;
    const { notes = "" } = req.body || {};
    const project = getProjectById(Number(projectId));
    if (!project) return res.status(404).json({ error: "not found" });
    const { tmux_session: session } = project;

    const timerInfo = findTimerForSession(session);
    if (!timerInfo) return res.status(400).json({ error: "no running timer" });

    const { start, file: dailyFile, marker } = timerInfo.data;
    const endIso = etNow().iso;

    try {
      closeTimerEntry(dailyFile, marker, endIso, notes || "(timer closed via dashboard fallback — notes missing)");
    } catch (err) {
      return res.status(500).json({ error: `daily file update failed: ${err.message}` });
    }

    try { unlinkSync(timerInfo.file); } catch {}

    const user = req.headers["tailscale-user-login"] || "";
    const state = sessions.get(projectId);
    if (state?.holder) releaseControl(state, projectId, user);
    auditLog("stop-local", projectId, session || "", "", user);
    res.json({ ok: true });
  });
}
