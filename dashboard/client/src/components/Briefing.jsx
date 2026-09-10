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

export default function Briefing({ onOpenProject, onOpenDraft }) {
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

  // The ✓ on a board item (and its undo from the cleared strip).
  const check = useCallback((key, done = true) => {
    fetch("/api/briefing/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, done }),
    }).then(() => fetchBriefing()).catch(() => {});
  }, [fetchBriefing]);

  if (!data) {
    return <div className="briefing-view"><div className="loading">{error ? `Briefing failed: ${error}` : "Loading briefing…"}</div></div>;
  }

  const { meta = {}, generating = {}, hello, supervisors = [], roster = [], recs, vitals = {}, board } = data;
  const itemState = new Map((board?.items || []).map((i) => [i.key, i]));
  const isDone = (key) => !!itemState.get(key)?.done;

  // The cleared strip needs labels; resolve them from the same artifacts the
  // sections render.
  const clearedItems = (board?.items || []).filter((i) => i.done).map((i) => {
    let label = i.key;
    if (i.key === "fire") label = recs?.fire?.title || "the fire";
    else if (i.key.startsWith("rec-")) label = recs?.recs?.[Number(i.key.slice(4))]?.title || i.key;
    else if (i.key.startsWith("attn-")) {
      const [, cid, idx] = i.key.split("-");
      const sup = supervisors.find((s) => String(s.company_id) === cid);
      label = sup ? `${sup.company}: ${sup.attention?.[Number(idx)]?.item || i.key}` : i.key;
    }
    return { ...i, label };
  }).concat(board?.pile?.cleared_items || []);
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

      {board && (() => {
        const beat = board.yesterday_pct > 0 && board.pct > board.yesterday_pct;
        const cleared = board.pct >= 100 && board.possible > 0;
        return (
          <div className="briefing-score"
            title={`${board.inbox.cleared} inbox items cleared · ${board.inbox.open} still open · board items are worth fire 10 / rec 5 / attention 3 / inbox 2`}>
            <div className="briefing-score-head">
              <span>Today <strong>{board.earned}</strong>/{board.possible} pts · <strong>{board.pct}%</strong></span>
              {cleared && <span className="briefing-score-beat">★ board cleared</span>}
              {!cleared && beat && <span className="briefing-score-beat">▲ beat yesterday</span>}
              <span className="briefing-score-marks">yesterday {board.yesterday_pct}% · best {board.best_pct}%</span>
            </div>
            <div className="briefing-score-track">
              <div className={`briefing-score-fill${beat || cleared ? " beat" : ""}`}
                style={{ width: `${Math.min(100, board.pct)}%` }} />
              {board.yesterday_pct > 0 && (
                <div className="briefing-score-notch" style={{ left: `${Math.min(99.5, board.yesterday_pct)}%` }} />
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
            {!isDone("fire") && (
              <div className="briefing-fire">
                <span className="briefing-fire-label">THE FIRE</span>
                <div className="briefing-fire-title">
                  {recs.fire.title}
                  {recs.fire.card_id != null && onOpenProject && (
                    <button className="briefing-cardlink" onClick={() => onOpenProject(recs.fire.card_id)}>#{recs.fire.card_id}</button>
                  )}
                  <button className="briefing-check" title="Did it — clear from the board (+10)" onClick={() => check("fire")}>✓ +10</button>
                </div>
                <div className="briefing-fire-why">{recs.fire.why}</div>
                {recs.fire.first_move && <div className="briefing-fire-move">First move: {recs.fire.first_move}</div>}
              </div>
            )}
            <ol className="briefing-reclist">
              {(recs.recs || []).map((r, i) => ({ r, i })).filter(({ i }) => !isDone(`rec-${i}`)).map(({ r, i }) => (
                <li key={i}>
                  <span className="briefing-rec-title">
                    {r.title}
                    {r.card_id != null && onOpenProject && (
                      <button className="briefing-cardlink" onClick={() => onOpenProject(r.card_id)}>#{r.card_id}</button>
                    )}
                  </span>
                  <span className="briefing-rec-why">{r.why}</span>
                  {r.effort && <span className="briefing-effort">{r.effort}</span>}
                  <button className="briefing-check" title="Did it — clear from the board (+5)" onClick={() => check(`rec-${i}`)}>✓</button>
                </li>
              ))}
            </ol>
            {isDone("fire") && (recs.recs || []).every((_, i) => isDone(`rec-${i}`)) && (
              <div className="briefing-empty">All recommendations cleared ★</div>
            )}
          </>
        ) : (
          <div className="briefing-empty">{generating.recs ? "Thinking about what matters most…" : "No recommendations generated yet — hit ↻."}</div>
        )}
      </section>

      <section className="briefing-card">
        <div className="briefing-sechead">
          <h2>Send pile</h2>
          <span className="briefing-age">{(data.sendpile || []).length} drafts waiting on you · +4 each when they leave Gmail</span>
        </div>
        {(data.sendpile || []).length === 0 ? (
          <div className="briefing-empty">Nothing drafted and waiting — the pile is clear ★</div>
        ) : (
          <ul className="briefing-pile">
            {data.sendpile.map((d) => (
              <li key={d.id}>
                <span className={`briefing-pile-age${d.age_days >= 7 ? " crit" : d.age_days >= 3 ? " warn" : ""}`}>
                  {d.age_days == null ? "—" : d.age_days === 0 ? "today" : `${d.age_days}d`}
                </span>
                <span className="briefing-pile-main">
                  <a href={d.threadUrl} target="_blank" rel="noreferrer" className="briefing-pile-subject">{d.subject}</a>
                  <span className="briefing-pile-to">to {d.to}</span>
                </span>
                {onOpenDraft && (
                  <button className="briefing-cardlink" title="Work this draft in the Mailroom — edit it directly or ask the session for changes"
                    onClick={() => onOpenDraft({ draftId: d.id, threadId: d.threadId })}>
                    ✎ Mailroom
                  </button>
                )}
                {d.card && onOpenProject && (
                  <button className={`briefing-cardlink${d.card.guess ? " guess" : ""}`}
                    title={d.card.guess ? `best guess for ${d.client}: ${d.card.name}` : d.card.name}
                    onClick={() => onOpenProject(d.card.id)}>
                    {d.card.guess ? "≈" : ""}#{d.card.id}
                  </button>
                )}
                {!d.card && d.client && <span className="briefing-pile-client">{d.client}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="briefing-pile-note">
          Nothing sends from here — open the draft, send it in Gmail, and the row clears itself.
          {data.sendpile_older > 0 && <> ({data.sendpile_older} drafts older than 60 days sit in Gmail, off the board — worth a cleanup pass someday.)</>}
        </div>
      </section>

      <section className="briefing-card">
        <SectionHead title="Hub check-ins" meta={meta.supervisors} section="supervisors" onRefresh={refresh} generating={generating.supervisors} />
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
                {(s.attention || []).length > 0 && (() => {
                  const open = s.attention.map((a, i) => ({ a, i })).filter(({ i }) => !isDone(`attn-${s.company_id}-${i}`));
                  if (open.length === 0) return <div className="briefing-sup-cleared">attention cleared ✓</div>;
                  return (
                    <ul className="briefing-sup-attn">
                      {open.map(({ a, i }) => (
                        <li key={i}>
                          <strong>{a.item}</strong> — {a.why}
                          {a.card_id != null && onOpenProject && (
                            <button className="briefing-cardlink" onClick={() => onOpenProject(a.card_id)}>#{a.card_id}</button>
                          )}
                          <button className="briefing-check" title="Handled — clear from the board (+3)" onClick={() => check(`attn-${s.company_id}-${i}`)}>✓</button>
                        </li>
                      ))}
                    </ul>
                  );
                })()}
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

      {clearedItems.length > 0 && (
        <section className="briefing-card briefing-clearedwrap">
          <div className="briefing-sechead"><h2>Cleared today ({clearedItems.length})</h2></div>
          <ul className="briefing-clearedlist">
            {clearedItems.map((c) => (
              <li key={c.key}>
                <span className="briefing-cleared-pts">+{c.value}</span>
                <span className="briefing-cleared-label">{c.label}</span>
                {c.auto
                  ? <span className="briefing-cleared-auto" title="Cleared automatically — its card was completed">auto</span>
                  : <button className="briefing-uncheck" title="Undo — back onto the board" onClick={() => check(c.key, false)}>undo</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="briefing-card briefing-opinbox">
        <OperatorInbox onOpenProject={onOpenProject} />
      </section>
    </div>
  );
}
