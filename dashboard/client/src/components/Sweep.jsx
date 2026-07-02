import { useState, useEffect, useMemo } from "react";

const STALE_DAYS = 14;

// next_step convention: optional "YYYY-MM-DD: " prefix marks a by-when date
function nextStepDate(next_step) {
  const m = /^(\d{4}-\d{2}-\d{2}):/.exec(next_step || "");
  return m ? m[1] : null;
}

function localToday() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
}

// updated_at is SQLite CURRENT_TIMESTAMP (UTC, "YYYY-MM-DD HH:MM:SS")
function daysSinceUpdate(updated_at) {
  if (!updated_at) return null;
  const t = new Date(updated_at.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function agoLabel(iso) {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function SweepSection({ id, icon, title, count, open, onToggle, children }) {
  return (
    <div className="analytics-accordion-section">
      <button
        className={`analytics-accordion-header${open ? " open" : ""}`}
        onClick={() => onToggle(id)}
      >
        <span className="analytics-caret">{open ? "▾" : "▸"}</span>
        <span className="sweep-section-icon">{icon}</span>
        {title}
        <span className="sweep-section-count">{count}</span>
      </button>
      {open && <div className="analytics-accordion-body">{children}</div>}
    </div>
  );
}

function CardRow({ p, onOpenProject, detail, suggestion }) {
  return (
    <div className="sweep-row" onClick={() => onOpenProject && onOpenProject(p.id)}>
      <div className="sweep-row-main">
        <span className="sweep-row-name">{p.name}</span>
        <span className="sweep-row-meta">
          {p.company_short || p.company_name || "—"}
          {p.division ? ` · ${p.division}` : ""}
          {" · "}
          <span className={`sweep-status-chip sweep-status-${p.status}`}>
            {p.status === "in_progress" ? "in progress" : p.status}
          </span>
        </span>
      </div>
      {detail && <div className="sweep-row-detail">{detail}</div>}
      {suggestion && <div className="sweep-row-suggestion">→ {suggestion}</div>}
    </div>
  );
}

export default function Sweep({ projects, onOpenProject, isAdmin }) {
  const [ai, setAi] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({
    quickwins: true,
    pastdue: true,
    nonext: false,
    stale: false,
    blocked: false,
    inbox: false,
  });

  useEffect(() => {
    fetch("/api/sweep")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.generated) setAi(d); })
      .catch(() => {});
  }, []);

  function toggle(key) {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function runAiReview() {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/sweep/run", { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAi(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  const active = useMemo(
    () => (projects || []).filter((p) => p.status === "in_progress" || p.status === "wfhuman"),
    [projects]
  );
  const byId = useMemo(() => new Map(active.map((p) => [p.id, p])), [active]);
  const suggestionById = useMemo(() => {
    const m = new Map();
    for (const s of ai?.suggestions || []) m.set(s.id, s.action);
    return m;
  }, [ai]);

  const today = localToday();

  const pastDue = useMemo(
    () =>
      active
        .map((p) => ({ p, date: nextStepDate(p.next_step) }))
        .filter(({ date }) => date && date < today)
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    [active, today]
  );
  const noNext = useMemo(
    () => active.filter((p) => !p.next_step || !p.next_step.trim()),
    [active]
  );
  const stale = useMemo(
    () =>
      active
        .map((p) => ({ p, days: daysSinceUpdate(p.updated_at) }))
        .filter(({ days }) => days !== null && days >= STALE_DAYS)
        .sort((a, b) => b.days - a.days),
    [active]
  );
  const inboxWaiting = useMemo(
    () => active.filter((p) => (p.inbox_count || 0) > 0),
    [active]
  );
  const quickWins = useMemo(
    () => (ai?.quick_wins || []).map((w) => ({ ...w, p: byId.get(w.id) })).filter((w) => w.p),
    [ai, byId]
  );
  const blocked = useMemo(
    () => (ai?.blocked || []).map((b) => ({ ...b, p: byId.get(b.id) })).filter((b) => b.p),
    [ai, byId]
  );

  return (
    <div className="analytics-page">
      <div className="sweep-header">
        <div>
          <h2 className="sweep-title">Sweep</h2>
          <div className="sweep-chips">
            {pastDue.length > 0 && <span className="sweep-chip sweep-chip-red">{pastDue.length} past due</span>}
            {noNext.length > 0 && <span className="sweep-chip">{noNext.length} no next step</span>}
            {stale.length > 0 && <span className="sweep-chip">{stale.length} stale</span>}
            {quickWins.length > 0 && <span className="sweep-chip sweep-chip-green">{quickWins.length} quick wins</span>}
            {pastDue.length === 0 && noNext.length === 0 && stale.length === 0 && (
              <span className="sweep-chip sweep-chip-green">✓ board is clean</span>
            )}
          </div>
        </div>
        <div className="sweep-header-right">
          {ai?.generated && (
            <span className={`sweep-ai-meta${ai.stale ? " stale" : ""}`}>
              AI review {agoLabel(ai.generated)}
            </span>
          )}
          {isAdmin && (
            <button className="sweep-run-btn" onClick={runAiReview} disabled={running}>
              {running ? "Sweeping… ~1-2 min" : ai?.generated ? "Re-run AI review" : "Run AI review"}
            </button>
          )}
        </div>
      </div>
      {error && <div className="sweep-error">AI review failed: {error}</div>}

      <SweepSection id="quickwins" icon="⚡" title="Quick Wins" count={quickWins.length} open={open.quickwins} onToggle={toggle}>
        {quickWins.length === 0 ? (
          <div className="analytics-empty">{ai?.generated ? "No quick wins flagged." : "Run the AI review to find quick wins."}</div>
        ) : (
          quickWins.map((w) => (
            <CardRow
              key={`qw-${w.id}`}
              p={w.p}
              onOpenProject={onOpenProject}
              detail={`${w.reason}${w.est_minutes ? ` (~${w.est_minutes}m)` : ""}`}
              suggestion={suggestionById.get(w.id)}
            />
          ))
        )}
      </SweepSection>

      <SweepSection id="pastdue" icon="🔴" title="Past next_step date" count={pastDue.length} open={open.pastdue} onToggle={toggle}>
        {pastDue.length === 0 ? (
          <div className="analytics-empty">Nothing past due.</div>
        ) : (
          pastDue.map(({ p, date }) => (
            <CardRow
              key={`pd-${p.id}`}
              p={p}
              onOpenProject={onOpenProject}
              detail={`${date} — ${(p.next_step || "").replace(/^\d{4}-\d{2}-\d{2}:\s*/, "")}`}
              suggestion={suggestionById.get(p.id)}
            />
          ))
        )}
      </SweepSection>

      <SweepSection id="nonext" icon="⭕" title="No next step" count={noNext.length} open={open.nonext} onToggle={toggle}>
        {noNext.length === 0 ? (
          <div className="analytics-empty">Every card has a next step.</div>
        ) : (
          noNext.map((p) => (
            <CardRow key={`nn-${p.id}`} p={p} onOpenProject={onOpenProject} suggestion={suggestionById.get(p.id)} />
          ))
        )}
      </SweepSection>

      <SweepSection id="stale" icon="💤" title={`Stale (${STALE_DAYS}+ days)`} count={stale.length} open={open.stale} onToggle={toggle}>
        {stale.length === 0 ? (
          <div className="analytics-empty">No stale cards.</div>
        ) : (
          stale.map(({ p, days }) => (
            <CardRow
              key={`st-${p.id}`}
              p={p}
              onOpenProject={onOpenProject}
              detail={`No update in ${days} days`}
              suggestion={suggestionById.get(p.id)}
            />
          ))
        )}
      </SweepSection>

      <SweepSection id="blocked" icon="🚧" title="Blocked / waiting" count={blocked.length} open={open.blocked} onToggle={toggle}>
        {blocked.length === 0 ? (
          <div className="analytics-empty">{ai?.generated ? "Nothing flagged as blocked." : "Run the AI review to classify blockers."}</div>
        ) : (
          blocked.map((b) => (
            <CardRow key={`bl-${b.id}`} p={b.p} onOpenProject={onOpenProject} detail={b.reason} suggestion={suggestionById.get(b.id)} />
          ))
        )}
      </SweepSection>

      <SweepSection id="inbox" icon="📥" title="Inbox waiting" count={inboxWaiting.length} open={open.inbox} onToggle={toggle}>
        {inboxWaiting.length === 0 ? (
          <div className="analytics-empty">No cards with linked inbox items.</div>
        ) : (
          inboxWaiting.map((p) => (
            <CardRow
              key={`ib-${p.id}`}
              p={p}
              onOpenProject={onOpenProject}
              detail={`${p.inbox_count} inbox item${p.inbox_count === 1 ? "" : "s"} linked`}
              suggestion={suggestionById.get(p.id)}
            />
          ))
        )}
      </SweepSection>
    </div>
  );
}
