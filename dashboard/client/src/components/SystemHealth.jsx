import { useCallback, useEffect, useRef, useState } from "react";

// System health — admin-only readout for "should I do proactive server work?"
// Polls GET /api/system/health every 5s, but ONLY while this view is mounted
// and the tab is visible (useProjects.js pattern). History lives in a ring
// buffer here in the client, so the server keeps no background sampler: close
// the view and the whole pipeline goes quiet.

const POLL_MS = 5000;
const MAX_POINTS = 120; // 10 minutes at 5s

const GB = 1024 ** 3;
const fmtGb = (b) => (b == null ? "—" : `${(b / GB).toFixed(1)} GB`);
const fmtUptime = (sec) => {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// ok | warn | crit, always displayed WITH the number — color never carries
// the value alone.
const level = (v, warn, crit) => (v == null ? "ok" : v >= crit ? "crit" : v >= warn ? "warn" : "ok");

function Meter({ pct, lvl }) {
  return (
    <div className="sys-meter" role="presentation">
      <div className={`sys-meter-fill ${lvl || level(pct, 80, 90)}`} style={{ width: `${Math.min(100, Math.max(0, pct || 0))}%` }} />
    </div>
  );
}

// Single-series sparkline: thin 2px line + soft area fill, fixed y-domain so
// the trend is honest (no auto-zoomed noise), crosshair hover with the value.
function Sparkline({ points, max = 100, unit = "%" }) {
  const [hover, setHover] = useState(null); // { i, x, y }
  const ref = useRef(null);
  const W = 240, H = 46, PAD = 3;
  const vals = points.map((p) => p.v);
  const n = vals.length;
  if (n < 2) return <div className="sys-spark sys-spark-empty">gathering…</div>;

  // Available points stretch across the full width (standard sparkline
  // behavior); the hover timestamp keeps the time axis honest as density
  // changes while samples accumulate.
  const x = (i) => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const y = (v) => H - PAD - (Math.min(v, max) / max) * (H - 2 * PAD);
  const line = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;

  function onMove(e) {
    const rect = ref.current.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((fx - PAD) / (W - 2 * PAD)) * (n - 1));
    if (i >= 0 && i < n) setHover({ i, x: x(i), y: y(vals[i]) });
    else setHover(null);
  }

  return (
    <div className="sys-spark" onMouseLeave={() => setHover(null)}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} aria-hidden="true">
        <path d={area} className="sys-spark-area" />
        <path d={line} className="sys-spark-line" vectorEffect="non-scaling-stroke" />
        {hover && (
          <>
            <line x1={hover.x} x2={hover.x} y1={PAD} y2={H - PAD} className="sys-spark-crosshair" vectorEffect="non-scaling-stroke" />
            <circle cx={hover.x} cy={hover.y} r="3" className="sys-spark-dot" />
          </>
        )}
      </svg>
      {hover && (
        <div className="sys-spark-tip" style={{ left: `${(hover.x / W) * 100}%` }}>
          {vals[hover.i].toFixed(1)}{unit} · {new Date(points[hover.i].t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </div>
      )}
    </div>
  );
}

function Dot({ lvl }) {
  return <span className={`sys-dot ${lvl}`} aria-hidden="true" />;
}

export default function SystemHealth() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [hist, setHist] = useState([]);
  const inFlight = useRef(0);

  const fetchHealth = useCallback(async () => {
    if (inFlight.current > 0) return;
    inFlight.current++;
    try {
      const r = await fetch("/api/system/health");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setData(d);
      setError(null);
      setHist((h) => {
        const memPct = d.mem ? (d.mem.used / d.mem.total) * 100 : null;
        const next = [...h, { t: d.ts, cpu: d.cpu?.pct, memPct, load1: d.cpu?.load?.[0] }];
        return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
      });
    } catch (e) {
      setError(e.message);
    } finally {
      inFlight.current--;
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const t = setInterval(() => { if (!document.hidden) fetchHealth(); }, POLL_MS);
    function onVisibility() { if (!document.hidden) fetchHealth(); }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchHealth]);

  if (!data) {
    return <div className="sys-view"><div className="sys-loading">{error ? `Health probe failed: ${error}` : "Reading system…"}</div></div>;
  }

  const { cpu, mem, disk, procs, tmux, services, tailscale, journalErrors24h } = data;
  const memPct = mem ? (mem.used / mem.total) * 100 : null;
  const memLvl = level(memPct, 85, 93);
  const swapPct = mem?.swapTotal ? (mem.swapUsed / mem.swapTotal) * 100 : 0;
  const cores = cpu?.cores || 1;
  const loadLvl = level(cpu?.load?.[0], cores * 0.7, cores);
  const tsDays = tailscale?.keyExpiryDays;
  const tsKeyLvl = tsDays == null ? "ok" : tsDays <= 7 ? "crit" : tsDays <= 30 ? "warn" : "ok";
  const tsUp = tailscale?.state === "Running" && tailscale?.online;

  return (
    <div className="sys-view">
      <div className="sys-header">
        <h2>System</h2>
        <span className="sys-header-note">
          {error ? `poll failing: ${error}` : `live · every ${POLL_MS / 1000}s while this view is open`}
        </span>
      </div>

      <div className="sys-grid">
        <div className="sys-card">
          <div className="sys-card-title">Memory</div>
          <div className={`sys-hero ${memLvl}`}>{memPct?.toFixed(0)}<span className="sys-hero-unit">%</span></div>
          <Meter pct={memPct} lvl={memLvl} />
          <div className="sys-sub">{fmtGb(mem?.used)} used of {fmtGb(mem?.total)} · {fmtGb(mem?.available)} available</div>
          <div className="sys-sub">Swap {fmtGb(mem?.swapUsed)} / {fmtGb(mem?.swapTotal)}{swapPct >= 25 ? " ⚠" : ""}</div>
          <Sparkline points={hist.filter((p) => p.memPct != null).map((p) => ({ t: p.t, v: p.memPct }))} />
        </div>

        <div className="sys-card">
          <div className="sys-card-title">CPU</div>
          <div className="sys-hero">{cpu?.pct == null ? "—" : cpu.pct.toFixed(0)}<span className="sys-hero-unit">%</span></div>
          <div className={`sys-sub ${loadLvl !== "ok" ? loadLvl : ""}`}>
            load {cpu?.load?.join(" · ")} on {cores} cores
          </div>
          <Sparkline points={hist.filter((p) => p.cpu != null).map((p) => ({ t: p.t, v: p.cpu }))} />
        </div>

        <div className="sys-card">
          <div className="sys-card-title">Disk</div>
          {(disk || []).map((d) => (
            <div key={d.mount} className="sys-disk-row">
              <div className="sys-disk-head">
                <span className="sys-disk-mount">{d.mount}</span>
                <span className={`sys-disk-pct ${level(d.pct, 80, 90)}`}>{d.pct?.toFixed(0)}%</span>
              </div>
              <Meter pct={d.pct} lvl={level(d.pct, 80, 90)} />
              <div className="sys-sub">{fmtGb(d.used)} used · {fmtGb(d.avail)} free</div>
            </div>
          ))}
        </div>

        <div className="sys-card">
          <div className="sys-card-title">Sessions</div>
          <div className="sys-stat-row">
            <div><div className="sys-stat">{tmux?.sessions ?? "—"}</div><div className="sys-sub">tmux sessions</div></div>
            <div><div className="sys-stat">{procs?.claude?.count ?? "—"}</div><div className="sys-sub">claude · {fmtGb((procs?.claude?.rssMb || 0) * 1048576)}</div></div>
            <div><div className="sys-stat">{procs?.node?.count ?? "—"}</div><div className="sys-sub">node · {fmtGb((procs?.node?.rssMb || 0) * 1048576)}</div></div>
          </div>
          <div className={`sys-line ${!tmux?.running ? "crit" : tmux?.bootEnabled === false ? "warn" : ""}`}>
            <Dot lvl={!tmux?.running ? "crit" : tmux?.bootEnabled === false ? "warn" : "ok"} />
            <span className="sys-svc-name">tmux server {tmux?.running ? "running" : "DOWN"}</span>
            <span className="sys-sub">
              {tmux?.bootEnabled == null ? "" : tmux.bootEnabled ? "auto-start at boot: enabled" : "auto-start at boot: DISABLED"}
            </span>
          </div>
        </div>

        <div className="sys-card">
          <div className="sys-card-title">Tailscale</div>
          <div className="sys-line"><Dot lvl={tsUp ? "ok" : "crit"} /> {tailscale ? `${tailscale.state}${tailscale.online ? " · online" : " · offline"}` : "unavailable"}</div>
          {tsDays != null && (
            <div className={`sys-line ${tsKeyLvl !== "ok" ? tsKeyLvl : ""}`}>
              <Dot lvl={tsKeyLvl} /> node key expires in {tsDays} days
            </div>
          )}
          <div className="sys-sub sys-note">Key expiry took the dashboard down on 9/3 — re-auth before this hits 0.</div>
        </div>

        <div className="sys-card">
          <div className="sys-card-title">Services</div>
          {(services?.failed || []).length > 0 && (
            <div className="sys-line crit"><Dot lvl="crit" /> failed: {services.failed.join(", ")}</div>
          )}
          <div className="sys-services">
            {(services?.watched || []).map((s) => (
              <div key={s.name} className="sys-line">
                <Dot lvl={s.state === "active" ? "ok" : s.state === "failed" ? "crit" : "muted"} />
                <span className="sys-svc-name">{s.name}</span>
                <span className="sys-sub">{s.state}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="sys-card sys-card-wide">
          <div className="sys-card-title">Top processes by memory</div>
          <table className="sys-table">
            <thead><tr><th>process</th><th>pid</th><th>mem</th><th>cpu</th></tr></thead>
            <tbody>
              {(procs?.top || []).map((p) => (
                <tr key={p.pid}>
                  <td>{p.comm}</td>
                  <td className="sys-num">{p.pid}</td>
                  <td className="sys-num">{p.rssMb} MB</td>
                  <td className="sys-num">{p.cpu.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sys-card">
          <div className="sys-card-title">Housekeeping</div>
          <div className="sys-line"><span className="sys-svc-name">Uptime</span><span className="sys-sub">{fmtUptime(data.uptimeSec)}</span></div>
          <div className="sys-line"><span className="sys-svc-name">Kernel</span><span className="sys-sub">{data.kernel || "—"}</span></div>
          <div className={`sys-line ${data.rebootRequired ? "warn" : ""}`}>
            <span className="sys-svc-name">Reboot required</span><span className="sys-sub">{data.rebootRequired ? "yes — pending updates" : "no"}</span>
          </div>
          <div className="sys-line"><span className="sys-svc-name">Journal errors (24h)</span><span className="sys-sub">{journalErrors24h ?? "—"}</span></div>
          <div className="sys-line"><span className="sys-svc-name">Dashboard DB</span><span className="sys-sub">{data.dbSizeMb != null ? `${data.dbSizeMb} MB` : "—"}</span></div>
        </div>
      </div>
    </div>
  );
}
