import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { marked } from "marked";
import { DIVISION_COLORS, DIVISION_WORDMARKS } from "../constants.js";

// Runrooms — a plan walked one step at a time, bound to the live Claude
// session that owns it. This view is READ-ONLY (build step 2): it renders
// what the session maintains in ~/OpenDia/runrooms/<session>/plan.json.
// The pty text box, actor buttons, and dialog rendering are build steps 3-5.
//
// Polling, not SSE: the source of truth is a small file rewritten atomically
// by the session, and a 2.5s poll of a local JSON read is cheaper than
// holding a stream open per viewer. The server already tolerates half-written
// files by returning the last good parse's 404/skip.

const STATE_GLYPHS = {
  done:    { glyph: "✓", cls: "done" },
  current: { glyph: "▶", cls: "current" },
  pending: { glyph: "○", cls: "pending" },
  failed:  { glyph: "✗", cls: "failed" },
  skipped: { glyph: "↷", cls: "skipped" },
  changed: { glyph: "~", cls: "changed" },
};

function StateGlyph({ state }) {
  const s = STATE_GLYPHS[state] || STATE_GLYPHS.pending;
  return <span className={`runroom-glyph ${s.cls}`}>{s.glyph}</span>;
}

// navigator.clipboard needs a secure context; the dashboard is reached over
// Tailscale by IP too, so keep the execCommand fallback (same trap as Rooms).
function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    return true;
  } catch {
    return false;
  }
}

function RoomHeader({ plan, hasActiveTimer }) {
  const wordmark = DIVISION_WORDMARKS[plan.division];
  const colors = DIVISION_COLORS[plan.division] || { bg: "#6b7280", text: "#fff" };
  const total = (plan.steps || []).length;
  const done = (plan.steps || []).filter((s) => s.state === "done").length;
  return (
    <header className="runroom-header">
      <div className="runroom-header-brand">
        {wordmark ? (
          <img src={wordmark} alt={plan.division} className="runroom-division-mark" />
        ) : plan.division ? (
          <span className="runroom-division-pill" style={{ backgroundColor: colors.bg, color: colors.text }}>
            {plan.division}
          </span>
        ) : null}
        <span className="runroom-header-meta">
          {plan.company}
          {plan.card_id != null && <> &middot; Card #{plan.card_id}{plan.card_name ? ` ${plan.card_name}` : ""}</>}
        </span>
      </div>
      <h1 className="runroom-title">{plan.title}</h1>
      <div className="runroom-header-status">
        {plan.status === "active" ? (
          <span className="runroom-badge active">Step {plan.current_step} of {total}</span>
        ) : (
          <span className={`runroom-badge ${plan.status}`}>{plan.status}</span>
        )}
        <span className="runroom-progress">{done}/{total} done</span>
        {hasActiveTimer && <span className="runroom-timer-dot" title="Timer running on this card">&#9679; timer running</span>}
        {plan.created && <span className="runroom-created">opened {plan.created.replace("T", " ")}</span>}
      </div>
    </header>
  );
}

function StepPane({ step }) {
  const paneRef = useRef(null);
  const html = useMemo(
    () => (step?.detail ? marked.parse(step.detail) : ""),
    [step?.detail]
  );

  // Decorate the rendered markdown: every fenced block gets a copy button,
  // and a fence whose preceding blockquote carries the skill's `> ⚠` warning
  // is styled as destructive. Done post-render because marked hands us HTML.
  useEffect(() => {
    const root = paneRef.current;
    if (!root) return;
    root.querySelectorAll("blockquote").forEach((bq) => {
      if ((bq.textContent || "").includes("⚠")) bq.classList.add("runroom-danger-note");
    });
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".runroom-copy-btn")) return;
      const prev = pre.previousElementSibling;
      if (prev?.classList?.contains("runroom-danger-note")) pre.classList.add("runroom-danger");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "runroom-copy-btn";
      btn.textContent = "copy";
      btn.addEventListener("click", () => {
        if (copyText(pre.querySelector("code")?.textContent ?? pre.textContent)) {
          btn.textContent = "copied";
          btn.classList.add("copied");
          setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("copied"); }, 1500);
        }
      });
      pre.appendChild(btn);
    });
  }, [html]);

  if (!step) return <div className="runroom-pane-empty">No step selected.</div>;
  return (
    <div className="runroom-pane">
      <div className="runroom-pane-head">
        <StateGlyph state={step.state} />
        <h2 className="runroom-step-title">Step {step.n} &mdash; {step.title}</h2>
        <span className={`runroom-actor actor-${step.actor}`}>
          {step.actor === "opendia" ? "OpenDia" : step.actor === "human" ? "hands-on" : "either"}
        </span>
      </div>
      <div className="runroom-step-detail" ref={paneRef}
           dangerouslySetInnerHTML={{ __html: html }} />
      {step.note && (
        <div className="runroom-step-note">
          <span className="runroom-step-note-label">note</span> {step.note}
        </div>
      )}
    </div>
  );
}

function CompletedSummary({ plan }) {
  return (
    <div className="runroom-pane runroom-summary">
      <h2 className="runroom-step-title">Plan {plan.status}</h2>
      <ul className="runroom-summary-list">
        {(plan.steps || []).map((s) => (
          <li key={s.n}>
            <StateGlyph state={s.state} />
            <span className="runroom-summary-step">{s.title}</span>
            {s.note && <span className="runroom-summary-note">{s.note}</span>}
          </li>
        ))}
      </ul>
      {plan.note && <div className="runroom-step-note">{plan.note}</div>}
    </div>
  );
}

function RoomView({ session, activeTimerIds, onBack, showBack }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [railOpen, setRailOpen] = useState(true);
  // null = follow the plan's current step as it moves; a number = the
  // operator clicked a rail item to read that step, so stay on it.
  const [viewStep, setViewStep] = useState(null);

  const fetchPlan = useCallback(() => {
    fetch(`/api/runrooms/${encodeURIComponent(session)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((p) => { setPlan(p); setError(null); })
      .catch((e) => setError(e.message));
  }, [session]);

  useEffect(() => {
    fetchPlan();
    const t = setInterval(fetchPlan, 2500);
    return () => clearInterval(t);
  }, [fetchPlan]);

  if (error) return <div className="runroom-error">Runroom unavailable: {error}</div>;
  if (!plan) return <div className="loading">Loading runroom...</div>;

  const shownN = viewStep ?? plan.current_step;
  const shown = (plan.steps || []).find((s) => s.n === shownN);
  const finished = plan.status !== "active";

  return (
    <div className="runroom-room">
      {showBack && (
        <button className="runroom-back" onClick={onBack}>&larr; all runrooms</button>
      )}
      <RoomHeader plan={plan} hasActiveTimer={activeTimerIds?.has(plan.card_id)} />
      <div className="runroom-body">
        <aside className={`runroom-rail${railOpen ? "" : " collapsed"}`}>
          <button className="runroom-rail-toggle" onClick={() => setRailOpen((v) => !v)}
                  title={railOpen ? "Collapse plan" : "Expand plan"}>
            {railOpen ? "PLAN ▾" : "▸"}
          </button>
          {railOpen && (plan.steps || []).map((s) => (
            <button
              key={s.n}
              className={`runroom-rail-step${s.n === shownN ? " viewing" : ""}${s.state === "current" ? " is-current" : ""}`}
              onClick={() => setViewStep(s.n === plan.current_step ? null : s.n)}
            >
              <StateGlyph state={s.state} />
              <span className="runroom-rail-title">{s.n}. {s.title}</span>
            </button>
          ))}
        </aside>
        <main className="runroom-main">
          {finished && viewStep == null ? <CompletedSummary plan={plan} /> : <StepPane step={shown} />}
        </main>
      </div>
    </div>
  );
}

export default function Runroom({ activeTimerIds }) {
  const [rooms, setRooms] = useState(null); // null = loading
  const [selected, setSelected] = useState(null);
  const [autoOpened, setAutoOpened] = useState(false);

  const fetchRooms = useCallback(() => {
    fetch("/api/runrooms")
      .then((r) => (r.ok ? r.json() : []))
      .then(setRooms)
      .catch(() => setRooms([]));
  }, []);

  useEffect(() => {
    fetchRooms();
    const t = setInterval(fetchRooms, 5000);
    return () => clearInterval(t);
  }, [fetchRooms]);

  // Exactly one active room → it is almost certainly why the operator is
  // here, so open it. Only once, so backing out to the list sticks.
  useEffect(() => {
    if (autoOpened || selected || !rooms) return;
    const active = rooms.filter((r) => r.status === "active");
    if (active.length === 1) { setSelected(active[0].session); setAutoOpened(true); }
  }, [rooms, selected, autoOpened]);

  if (selected) {
    return (
      <RoomView
        session={selected}
        activeTimerIds={activeTimerIds}
        onBack={() => { setSelected(null); setAutoOpened(true); }}
        showBack={(rooms || []).length > 1}
      />
    );
  }

  if (rooms === null) return <div className="loading">Loading runrooms...</div>;
  if (rooms.length === 0) {
    return (
      <div className="runroom-empty">
        <h2>No runrooms open</h2>
        <p>Agree on a plan in a work session, then run <code>/runroom</code> there to open one.</p>
      </div>
    );
  }

  return (
    <div className="runroom-list">
      {rooms.map((r) => {
        const colors = DIVISION_COLORS[r.division] || { bg: "#6b7280", text: "#fff" };
        return (
          <button key={r.session} className="runroom-list-item" onClick={() => setSelected(r.session)}>
            <span className="runroom-division-pill" style={{ backgroundColor: colors.bg, color: colors.text }}>
              {r.division || "?"}
            </span>
            <span className="runroom-list-title">{r.title}</span>
            <span className="runroom-list-meta">
              {r.company} &middot; {r.steps_done}/{r.steps_total}
              {r.status !== "active" && <> &middot; {r.status}</>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
