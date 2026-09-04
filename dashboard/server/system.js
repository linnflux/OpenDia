// System health — the admin-only "should I do proactive server work?" view.
//
// One endpoint, GET /api/system/health, polled by the client only while the
// System view is open. Every collector is individually fail-soft (null on
// error) so one broken probe never costs the payload. No background sampling:
// the CPU delta and the two cached probes (tailscale, journal) only advance
// when a request arrives.

import os from "os";
import { readFileSync, statfsSync, statSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { requireAdmin } from "./auth.js";
import { DB_PATH } from "./config.js";

const WATCHED_UNITS = [
  "opendia-dashboard", "opendia-rooms", "cloudflared-opendia",
  "mcp-notion", "mcp-google-workspace", "mcp-square", "mcp-toggl",
];

function tryProbe(fn) {
  try { return fn(); } catch { return null; }
}

// ---- CPU ------------------------------------------------------------------

// /proc/stat aggregate line, sampled per request; % is the busy share of the
// delta since the previous request (null on the first call after a restart).
let lastCpu = null;

function cpuInfo() {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
  const t = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = t[3] + (t[4] || 0); // idle + iowait
  const total = t.reduce((a, b) => a + b, 0);
  let pct = null;
  if (lastCpu && total > lastCpu.total) {
    pct = Math.round((1 - (idle - lastCpu.idle) / (total - lastCpu.total)) * 1000) / 10;
  }
  lastCpu = { idle, total };
  return { pct, load: os.loadavg().map((n) => Math.round(n * 100) / 100), cores: os.cpus().length };
}

// ---- Memory ---------------------------------------------------------------

function memInfo() {
  const kv = {};
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = parseInt(m[2], 10) * 1024; // kB → bytes
  }
  return {
    total: kv.MemTotal, available: kv.MemAvailable,
    used: kv.MemTotal - kv.MemAvailable,
    swapTotal: kv.SwapTotal, swapUsed: kv.SwapTotal - kv.SwapFree,
  };
}

// ---- Disk -----------------------------------------------------------------

const REAL_FS = new Set(["ext4", "ext3", "xfs", "btrfs", "vfat", "ntfs"]);

function diskInfo() {
  const seen = new Set();
  const out = [];
  for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
    const [dev, mount, fstype] = line.split(" ");
    if (!REAL_FS.has(fstype) || seen.has(dev)) continue;
    seen.add(dev);
    const s = tryProbe(() => statfsSync(mount));
    if (!s) continue;
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    out.push({
      mount, total, avail, used: total - avail,
      pct: total ? Math.round(((total - avail) / total) * 1000) / 10 : null,
    });
  }
  return out;
}

// ---- Processes ------------------------------------------------------------

function procInfo() {
  const raw = execFileSync("ps", ["-eo", "pid,comm,rss,pcpu", "--sort=-rss"], { timeout: 4000 })
    .toString().trim().split("\n").slice(1);
  const rows = raw.map((l) => {
    const m = l.trim().match(/^(\d+)\s+(.+?)\s+(\d+)\s+([\d.]+)$/);
    return m ? { pid: +m[1], comm: m[2], rssMb: Math.round(m[3] / 1024), cpu: +m[4] } : null;
  }).filter(Boolean);
  const agg = (name) => {
    const hits = rows.filter((r) => r.comm === name);
    return { count: hits.length, rssMb: hits.reduce((a, r) => a + r.rssMb, 0) };
  };
  return { top: rows.slice(0, 8), claude: agg("claude"), node: agg("node") };
}

// ---- tmux -----------------------------------------------------------------

// tmux is NOT judged by its systemd unit: the unit only matters at boot, and
// a manually-started server (unit inactive) is still a healthy server. What
// the operator cares about is (a) server up and (b) will it come back at boot.
function tmuxInfo() {
  const out = tryProbe(() => execFileSync("tmux", ["ls"], { timeout: 3000 }).toString());
  let bootEnabled = null;
  try {
    bootEnabled = execFileSync("systemctl", ["--user", "is-enabled", "tmux"], { timeout: 3000 }).toString().trim() === "enabled";
  } catch (e) {
    const s = (e.stdout || "").toString().trim();
    bootEnabled = s ? s === "enabled" : null; // "disabled" exits nonzero but prints
  }
  return {
    running: out != null,
    sessions: out ? out.trim().split("\n").filter(Boolean).length : 0,
    bootEnabled,
  };
}

// ---- systemd user units ---------------------------------------------------

function serviceInfo() {
  const failed = tryProbe(() =>
    execFileSync("systemctl", ["--user", "list-units", "--type=service", "--state=failed", "--no-legend", "--plain"], { timeout: 4000 })
      .toString().trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0])
  ) || [];
  // is-active exits nonzero when any unit is not active, but stdout still has
  // one state per line — read it from the error object.
  let states = [];
  try {
    states = execFileSync("systemctl", ["--user", "is-active", ...WATCHED_UNITS], { timeout: 4000 })
      .toString().trim().split("\n");
  } catch (e) {
    states = (e.stdout || "").toString().trim().split("\n");
  }
  const watched = WATCHED_UNITS.map((name, i) => ({ name, state: states[i] || "unknown" }));
  return { failed, watched };
}

// ---- tailscale (cached 30s — key expiry doesn't move fast) ----------------

let tsCache = { at: 0, value: null };

function tailscaleInfo() {
  if (Date.now() - tsCache.at < 30_000) return tsCache.value;
  const value = tryProbe(() => {
    const j = JSON.parse(execFileSync("tailscale", ["status", "--json", "--peers=false"], { timeout: 5000 }).toString());
    let keyExpiryDays = null;
    if (j.Self?.KeyExpiry) {
      keyExpiryDays = Math.floor((new Date(j.Self.KeyExpiry) - Date.now()) / 86_400_000);
    }
    return { state: j.BackendState || "unknown", online: !!j.Self?.Online, keyExpiryDays };
  });
  tsCache = { at: Date.now(), value };
  return value;
}

// ---- journal errors (cached 60s — the one potentially slow probe) ---------

let journalCache = { at: 0, value: null };

function journalErrors24h() {
  if (Date.now() - journalCache.at < 60_000) return journalCache.value;
  const value = tryProbe(() => {
    const out = execFileSync("journalctl", ["--user", "-p", "3", "--since", "-24 hours", "-q", "--no-pager", "-o", "cat"], { timeout: 6000 }).toString();
    return out.trim() ? out.trim().split("\n").length : 0;
  });
  journalCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------

export function registerSystemRoutes(app) {
  app.get("/api/system/health", requireAdmin, (_req, res) => {
    res.json({
      ts: Date.now(),
      cpu: tryProbe(cpuInfo),
      mem: tryProbe(memInfo),
      disk: tryProbe(diskInfo),
      procs: tryProbe(procInfo),
      tmux: tryProbe(tmuxInfo),
      services: tryProbe(serviceInfo),
      tailscale: tailscaleInfo(),
      journalErrors24h: journalErrors24h(),
      uptimeSec: Math.round(os.uptime()),
      kernel: os.release(),
      rebootRequired: existsSync("/var/run/reboot-required"),
      dbSizeMb: tryProbe(() => Math.round(statSync(DB_PATH).size / 1048576 * 10) / 10),
    });
  });
}
