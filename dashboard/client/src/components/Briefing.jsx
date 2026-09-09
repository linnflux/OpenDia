import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { OperatorInbox } from "./Agents.jsx";
import { CompanyMark } from "./RoomListCard.jsx";

// Briefing — the admin morning view. Everything generated lands as dated
// artifacts server-side (cron at 06:30 ET, or the ↻ buttons); this view is a
// reader with live vitals. Poll only while mounted + tab visible (the System
// view pattern). System warnings come from one /api/system/health fetch on
// mount — no ongoing health polling from here.

const POLL_MS = 30_000;

const fmtAge = (iso) => {
  if (!iso) return null;
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${min % 60}m ago` : `${Math.floor(h / 24)}d ago`;
};

function SectionHead({ title, meta, section, onRefresh, generating }) {
  return (
    <div className="briefing-sechead">
      <h2>{title}</h2>
      {meta?.generated_at && <span className="briefing-age">{fmtAge(meta.generated_at)}</span>}
      {meta?.error && <span className="briefing-err" title={meta.error}>generation error</span>}
      {onRefresh && (
        <button className="briefing-refresh" disabled={generating} title={`Regenerate ${title.toLowerCase()}`}
          onClick={() => onRefresh(section)}>
          {generating ? "generating…" : "↻"}
        </button>
      )}
    </div>
  );
}

export default function Briefing({ onOpenProject }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [health, setHealth] = useState(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const inFlightRef = useRef(0);

  const fetchBriefing = useCallback(async () => {
    if (inFlightRef.current > 0) return;
    inFlightRef.current++;
    try {
      const r = await fetch("/api/briefing");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      inFlightRef.current--;
    }
  }, []);

  useEffect(() => {
    fetchBriefing();
    fetch("/api/system/health").then((r) => (r.ok ? r.json() : null)).then(setHealth).catch(() => {});
    const t = setInterval(() => { if (!document.hidden) fetchBriefing(); }, POLL_MS);
    function onVisibility() { if (!document.hidden) fetchBriefing(); }
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisibility); };
  }, [fetchBriefing]);

  const refresh = useCallback((section) => {
    fetch(`/api/briefing/generate?section=${section}`, { method: "POST" })
      .then(() => fetchBriefing())
      .catch(() => {});
  }, [fetchBriefing]);

  if (!data) {
    return <div className="briefing-view"><div className="loading">{error ? `Briefing failed: ${error}` : "Loading briefing…"}</div></div>;
  }

  const { meta = {}, generating = {}, hello, supervisors = [], roster = [], recs, vitals = {} } = data;
  const dateLabel = new Date(`${data.date}T12:00:00`).toLocaleDateString([], {
    weekday: "long", month: "long", day: "numeric",
  });

  // System warnings only when something is actually warn/crit — silence is nominal.
  const warnings = [];
  if (health) {
    for (const d of health.disk || []) if (d.pct >= 80) warnings.push({ text: `disk ${d.mount} at ${d.pct.toFixed(0)}%`, crit: d.pct >= 90 });
    if (health.mem && health.mem.available / health.mem.total < 0.15) warnings.push({ text: "memory low", crit: health.mem.available / health.mem.total < 0.07 });
    const days = health.tailscale?.keyExpiryDays;
    if (days != null && days <= 30) warnings.push({ text: `tailscale key expires in ${days}d`, crit: days <= 7 });
    for (const f of health.services?.failed || []) warnings.push({ text: `${f} failed`, crit: true });
    if (health.rebootRequired) warnings.push({ text: "reboot required", crit: false });
  }

  const missingCheckins = roster.filter((r) => !supervisors.some((s) => s.company === r.company));

  // Collapsed brief: everything before the third "## " heading is the excerpt.
  let briefExcerpt = hello;
  if (hello && !briefOpen) {
    const idx = [...hello.matchAll(/^## /gm)].map((m) => m.index);
    if (idx.length > 2) briefExcerpt = hello.slice(0, idx[2]);
    else briefExcerpt = hello.slice(0, 1600);
  }

  return (
    <div className="briefing-view">
      <header className="briefing-masthead">
        <div>
          <h1>{dateLabel}</h1>
          <span className="briefing-sub">the morning briefing · generated content refreshes at 6:30 AM ET</span>
        </div>
        <button className="briefing-refresh-all" onClick={() => refresh("all")}
          disabled={generating.hello || generating.supervisors || generating.recs}>
          ↻ Refresh all
        </button>
      </header>

      {data.score && (() => {
        const s = data.score;
        const max = Math.max(s.points, s.yesterday, 10);
        const beat = s.yesterday > 0 && s.points > s.yesterday;
        return (
          <div className="briefing-score"
            title={`${s.breakdown.cards} cards completed · ${s.breakdown.sessions} work sessions closed · ${s.breakdown.acks} inbox items cleared · ${s.breakdown.actions} actions resolved`}>
            <div className="briefing-score-head">
              <span>Today <strong>{s.points}</strong></span>
              {beat && <span className="briefing-score-beat">▲ beat yesterday</span>}
              <span className="briefing-score-marks">yesterday {s.yesterday} · best {s.best}</span>
            </div>
            <div className="briefing-score-track">
              <div className={`briefing-score-fill${beat ? " beat" : ""}`}
                style={{ width: `${Math.min(100, (s.points / max) * 100)}%` }} />
              {s.yesterday > 0 && (
                <div className="briefing-score-notch" style={{ left: `${Math.min(99.5, (s.yesterday / max) * 100)}%` }} />
              )}
            </div>
          </div>
        );
      })()}

      <div className="briefing-vitals">
        {vitals.hours?.billable && (
          <span className="briefing-chip">billable {vitals.hours.billable.opendia?.toFixed(2)}h
            {vitals.hours.billable.toggl != null && <em> · toggl {vitals.hours.billable.toggl.toFixed(2)}</em>}
          </span>
        )}
        {vitals.hours?.internal && (
          <span className="briefing-chip">internal {vitals.hours.internal.opendia?.toFixed(2)}h</span>
        )}
        <span className={`briefing-chip${(vitals.spark_proposals || []).length ? " warn" : ""}`}>
          {(vitals.spark_proposals || []).length} spark proposals waiting
        </span>
        <span className={`briefing-chip${(vitals.planroom_wakeups || []).length ? " warn" : ""}`}>
          {(vitals.planroom_wakeups || []).length} planroom wakeups due
        </span>
        {warnings.map((w, i) => (
          <span key={i} className={`briefing-chip ${w.crit ? "crit" : "warn"}`}>⚠ {w.text}</span>
        ))}
      </div>

      <section className="briefing-card briefing-recs">
        <SectionHead title="OD Recs" meta={meta.recs} section="recs" onRefresh={refresh} generating={generating.recs} />
        {recs?.fire ? (
          <>
            <div className="briefing-fire">
              <span className="briefing-fire-label">THE FIRE</span>
              <div className="briefing-fire-title">
                {recs.fire.title}
                {recs.fire.card_id != null && onOpenProject && (
                  <button className="briefing-cardlink" onClick={() => onOpenProject(recs.fire.card_id)}>#{recs.fire.card_id}</button>
                )}
              </div>
              <div className="briefing-fire-why">{recs.fire.why}</div>
              {recs.fire.first_move && <div className="briefing-fire-move">First move: {recs.fire.first_move}</div>}
            </div>
            <ol className="briefing-reclist">
              {(recs.recs || []).map((r, i) => (
                <li key={i}>
                  <span className="briefing-rec-title">
                    {r.title}
                    {r.card_id != null && onOpenProject && (
                      <button className="briefing-cardlink" onClick={() => onOpenProject(r.card_id)}>#{r.card_id}</button>
                    )}
                  </span>
                  <span className="briefing-rec-why">{r.why}</span>
                  {r.effort && <span className="briefing-effort">{r.effort}</span>}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="briefing-empty">{generating.recs ? "Thinking about what matters most…" : "No recommendations generated yet — hit ↻."}</div>
        )}
      </section>

      <section className="briefing-card">
        <SectionHead title="Supervisor check-ins" meta={meta.supervisors} section="supervisors" onRefresh={refresh} generating={generating.supervisors} />
        {supervisors.length === 0 ? (
          <div className="briefing-empty">{generating.supervisors ? "Checking in with each company…" : "No check-ins yet — hit ↻."}</div>
        ) : (
          <div className="briefing-supgrid">
            {supervisors.map((s) => (
              <div key={s.company_id} className={`briefing-sup ${s.status}`}>
                <div className="briefing-sup-head">
                  <span className={`sys-dot ${s.status === "attention" ? "warn" : "ok"}`} />
                  <CompanyMark company={s.company} />
                  {s.supervisor_card && onOpenProject && (
                    <button className="briefing-cardlink" onClick={() => onOpenProject(s.supervisor_card.id)}>#{s.supervisor_card.id}</button>
                  )}
                </div>
                <div className="briefing-sup-summary">{s.summary}</div>
                {(s.attention || []).length > 0 && (
                  <ul className="briefing-sup-attn">
                    {s.attention.map((a, i) => (
                      <li key={i}>
                        <strong>{a.item}</strong> — {a.why}
                        {a.card_id != null && onOpenProject && (
                          <button className="briefing-cardlink" onClick={() => onOpenProject(a.card_id)}>#{a.card_id}</button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {missingCheckins.map((r) => (
              <div key={r.company} className="briefing-sup missing">
                <div className="briefing-sup-head"><span className="sys-dot muted" /><CompanyMark company={r.company} /></div>
                <div className="briefing-sup-summary">No check-in generated this morning.</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="briefing-card">
        <SectionHead title="Morning brief" meta={meta.hello} section="hello" onRefresh={refresh} generating={generating.hello} />
        {hello ? (
          <>
            <div className="briefing-hello markdown-body"
              dangerouslySetInnerHTML={{ __html: marked.parse(briefOpen ? hello : briefExcerpt) }} />
            <button className="briefing-expand" onClick={() => setBriefOpen((v) => !v)}>
              {briefOpen ? "Collapse" : "Show the full brief"}
            </button>
          </>
        ) : (
          <div className="briefing-empty">
            {generating.hello ? "Running the morning sweep (a few minutes)…"
              : "No brief for this date yet — the 6:30 cron writes it, /hello in the operator session writes it, or hit ↻."}
          </div>
        )}
      </section>

      <section className="briefing-card briefing-opinbox">
        <OperatorInbox onOpenProject={onOpenProject} />
      </section>
    </div>
  );
}
