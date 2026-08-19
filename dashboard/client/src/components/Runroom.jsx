import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { marked } from "marked";
import { DIVISION_COLORS, DIVISION_WORDMARKS } from "../constants.js";
import {
  StateGlyph, decorateMarkdown, primeAudio, playDoneChime, ThinkingStrip,
  GATE_REASONS, firstNameOf, DialogCard, LiveOutput, Composer,
} from "./runroom/shared.jsx";

// Runrooms — a plan walked one step at a time, bound to the live Claude
// session that owns it. This view is READ-ONLY (build step 2): it renders
// what the session maintains in ~/OpenDia/runrooms/<session>/plan.json.
// The pty text box, actor buttons, and dialog rendering are build steps 3-5.
//
// Polling, not SSE: the source of truth is a small file rewritten atomically
// by the session, and a 2.5s poll of a local JSON read is cheaper than
// holding a stream open per viewer. The server already tolerates half-written
// files by returning the last good parse's 404/skip.
//
// StateGlyph, copyText/decorateMarkdown, the completion chime, ThinkingStrip,
// GATE_REASONS, firstNameOf, DialogCard, LiveOutput and Composer live in
// runroom/shared.jsx — Mailroom.jsx binds to a different session over the
// same modal-gate machinery and reuses them unchanged.

function RoomHeader({ plan, hasActiveTimer, onOpenProject }) {
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
          {plan.card_id != null && (
            <>
              {" "}&middot;{" "}
              {onOpenProject ? (
                <button
                  className="runroom-card-link"
                  title="Open the card"
                  onClick={() => onOpenProject(plan.card_id)}
                >
                  Card #{plan.card_id}{plan.card_name ? ` ${plan.card_name}` : ""}
                </button>
              ) : (
                <>Card #{plan.card_id}{plan.card_name ? ` ${plan.card_name}` : ""}</>
              )}
            </>
          )}
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
        {plan.plan_mtime && (() => {
          // Steps-age readout: a session can be alive and productive while
          // never touching plan.json — without this line that room is
          // indistinguishable from one that's simply finished talking.
          const mins = Math.max(0, Math.round((Date.now() - plan.plan_mtime) / 60000));
          const rel = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
          // Two drift shapes: the session is visibly working on an old plan,
          // or the operator has sent things since the plan last moved (the
          // quieter failure — work happened, the room was never told).
          const sentSince = plan.sends_mtime && plan.sends_mtime > plan.plan_mtime + 60_000;
          const drifting = (mins >= 10 && plan.gate?.working) || (mins >= 10 && sentSince);
          return (
            <span className={`runroom-plan-age${drifting ? " drifting" : ""}`}>
              steps updated {rel}{drifting ? " — the session may not be keeping the room current" : ""}
            </span>
          );
        })()}
      </div>
    </header>
  );
}

function StepPane({ step, total, working }) {
  const paneRef = useRef(null);
  const html = useMemo(
    () => (step?.detail ? marked.parse(step.detail) : ""),
    [step?.detail]
  );

  // Decorate the rendered markdown: every fenced block gets a copy button,
  // and a fence whose preceding blockquote carries the skill's `> ⚠` warning
  // is styled as destructive. Done post-render because marked hands us HTML.
  useEffect(() => {
    decorateMarkdown(paneRef.current);
  }, [html]);

  if (!step) return <div className="runroom-pane-empty">No step selected.</div>;
  // key={step.n} re-mounts the pane on step change so the enter animation
  // plays — one gentle breath per step, not per poll.
  return (
    <div className={`runroom-pane${working ? " working" : ""}`} key={step.n}>
      <div className="runroom-overline">
        <span className="runroom-overline-step">Step {step.n} of {total}</span>
        <span className={`runroom-actor actor-${step.actor}`}>
          {step.actor === "opendia" ? "OpenDia" : step.actor === "human" ? "hands-on" : "either"}
        </span>
      </div>
      <div className="runroom-breath" aria-hidden="true">
        <span style={{ width: `${Math.round(((step.n - 1) / Math.max(total, 1)) * 100)}%` }} />
      </div>
      <h2 className="runroom-step-title">{step.title}</h2>
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

// Actor buttons for the CURRENT step. Every button names its actor, and its
// visible effect arrives through plan.json on the next poll — the session
// flips the step's actor/state per the canned instruction, not the client.
function ActionRow({ session, step, gate, me }) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const name = firstNameOf(me);
  const blocked = !gate?.ok;

  async function act(action) {
    if (busy) return;
    setBusy(true); setFlash(null);
    try {
      const r = await fetch(`/api/runrooms/${encodeURIComponent(session)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, step: step.n }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setFlash({ ok: false, msg: GATE_REASONS[d?.gate?.reason] || d?.error || `HTTP ${r.status}` });
      else { setFlash({ ok: true, msg: "sent — the session has it" }); setTimeout(() => setFlash(null), 3000); }
    } catch (e) {
      setFlash({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  const disabled = blocked || busy;
  const buttons =
    step.actor === "either" ? (
      <>
        <button className="runroom-act primary" disabled={disabled} onClick={() => act("opendia_do")}>OpenDia does it</button>
        <button className="runroom-act" disabled={disabled} onClick={() => act("human_do")}>{name} does it</button>
      </>
    ) : step.actor === "human" ? (
      <>
        <button className="runroom-act primary" disabled={disabled} onClick={() => act("human_done")}>{name} finished</button>
        <button className="runroom-act danger" disabled={disabled} onClick={() => act("human_failed")}>It failed</button>
      </>
    ) : (
      <>
        <button className="runroom-act primary" disabled={disabled} onClick={() => act("opendia_do")}>OpenDia does it</button>
        <button className="runroom-act" disabled={disabled} onClick={() => act("human_done")}>{name} finished</button>
      </>
    );

  return (
    <div className="runroom-actions">
      {buttons}
      {flash && <span className={`runroom-send-flash ${flash.ok ? "ok" : "err"}`}>{flash.msg}</span>}
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

function RoomView({ session, activeTimerIds, onBack, showBack, me, onOpenProject }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [railOpen, setRailOpen] = useState(true);
  // null = follow the plan's current step as it moves; a number = the
  // operator clicked a rail item to read that step, so stay on it.
  const [viewStep, setViewStep] = useState(null);
  // undefined = no observation yet (never chime on the first poll);
  // afterwards: was the session working at the last poll?
  const wasWorking = useRef(undefined);
  // Composer/DialogCard take endpoints, not a session name, so Mailroom.jsx
  // can pass its own URLs through the same components unchanged.
  const endpoints = useMemo(() => ({
    send: `/api/runrooms/${encodeURIComponent(session)}/send`,
    image: `/api/runrooms/${encodeURIComponent(session)}/image`,
    dialog: `/api/runrooms/${encodeURIComponent(session)}/dialog`,
  }), [session]);

  const fetchPlan = useCallback(() => {
    fetch(`/api/runrooms/${encodeURIComponent(session)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((p) => {
        // Chime on the working -> idle edge: the answer to "is it done yet?"
        // for an operator who is looking at another window.
        const nowWorking = !!p.gate?.working;
        if (wasWorking.current === true && !nowWorking && p.status === "active") playDoneChime();
        wasWorking.current = nowWorking;
        setPlan(p);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [session]);

  // Tighten the poll while live output is streaming — 1.2s reads as "live"
  // in the viewbox; 2.5s is plenty for everything else the room shows.
  const streaming = !!(plan?.live_output && plan?.gate?.working);
  useEffect(() => {
    fetchPlan();
    const t = setInterval(fetchPlan, streaming ? 1200 : 2500);
    return () => clearInterval(t);
  }, [fetchPlan, streaming]);

  if (error) return <div className="runroom-error">Runroom unavailable: {error}</div>;
  if (!plan) return <div className="loading">Loading runroom...</div>;

  const shownN = viewStep ?? plan.current_step;
  const shown = (plan.steps || []).find((s) => s.n === shownN);
  const finished = plan.status !== "active";
  // Every step done but status still "active": the work is over and the
  // session just hasn't closed the room. Without this the page keeps showing
  // the current step's instructions as if pending — the room lies finished-
  // work into looking outstanding.
  const allDone = !finished
    && (plan.steps || []).length > 0
    && (plan.steps || []).every((s) => s.state === "done");

  return (
    <div className="runroom-room">
      {showBack && (
        <button className="runroom-back" onClick={onBack}>&larr; all runrooms</button>
      )}
      <RoomHeader plan={plan} hasActiveTimer={activeTimerIds?.has(plan.card_id)} onOpenProject={onOpenProject} />
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
          {/* Plan mode blocks all file writes in the session — including
              plan.json — so the steps here are frozen until the plan is
              approved. Without this banner a planning session reads as stuck. */}
          {!finished && plan.gate?.planMode && (
            <div className="runroom-planmode">
              ⏸ The session is in <strong>plan mode</strong> — steps here are frozen until its plan
              is approved. Answer its questions, or send &ldquo;wrap up and present your plan&rdquo; —
              the approval buttons will appear right here when it does.
            </div>
          )}
          {allDone && (
            <div className="runroom-alldone">
              ✓ Every step is done — the room just hasn't been closed. Ask the session to
              &ldquo;close the runroom&rdquo; (it sets status done in plan.json), or it will close at /od-stop.
            </div>
          )}
          {finished && viewStep == null ? <CompletedSummary plan={plan} /> : <StepPane step={shown} total={(plan.steps || []).length} working={!finished && !!plan.gate?.working} />}
          {/* Action buttons aim at the current step only — reading an earlier
              step must not offer buttons that would fire at a different one. */}
          {!finished && shown && shown.n === plan.current_step && (
            <ActionRow session={session} step={shown} gate={plan.gate} me={me} />
          )}
          {!finished && plan.live_output?.lines?.length > 0 && (
            <LiveOutput live={plan.live_output} />
          )}
          {!finished && plan.gate?.reason === "dialog-open" && plan.gate?.dialog && (
            <DialogCard key={plan.gate.dialog.fingerprint} dialog={plan.gate.dialog} endpoints={endpoints} />
          )}
          {!finished && <ThinkingStrip working={plan.gate?.working} />}
          {!finished && <Composer gate={plan.gate} endpoints={endpoints} />}
        </main>
      </div>
    </div>
  );
}

export default function Runroom({ activeTimerIds, me, onOpenProject }) {
  const [rooms, setRooms] = useState(null); // null = loading
  const [selected, setSelected] = useState(null);
  const [autoOpened, setAutoOpened] = useState(false);

  // Prime the audio context on the first real gesture anywhere in the view,
  // so the completion chime is allowed to sound later.
  useEffect(() => {
    const prime = () => primeAudio();
    window.addEventListener("pointerdown", prime, { once: true });
    window.addEventListener("keydown", prime, { once: true });
    return () => {
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("keydown", prime);
    };
  }, []);

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
        me={me}
        onOpenProject={onOpenProject}
        onBack={() => { setSelected(null); setAutoOpened(true); }}
        showBack={(rooms || []).length > 1}
      />
    );
  }

  if (rooms === null) return <div className="loading">Loading runrooms...</div>;

  const active = (rooms || []).filter((r) => r.status === "active");
  const finished = (rooms || []).filter((r) => r.status !== "active");

  const heading = (
    <header className="runroom-list-header">
      <h1 className="runroom-list-heading">Runrooms</h1>
      <span className="runroom-list-count">
        {active.length} active{finished.length > 0 && <> &middot; {finished.length} finished</>}
      </span>
    </header>
  );

  if (rooms.length === 0) {
    return (
      <div className="runroom-list">
        {heading}
        <div className="runroom-empty">
          <h2>No runrooms open</h2>
          <p>Agree on a plan in a work session, then run <code>/runroom</code> there to open one.</p>
        </div>
      </div>
    );
  }

  // Same wordmark-or-pill fallback the room header uses, at list scale.
  const roomItem = (r) => {
    const wordmark = DIVISION_WORDMARKS[r.division];
    const colors = DIVISION_COLORS[r.division] || { bg: "#6b7280", text: "#fff" };
    const live = r.status === "active";
    return (
      <button
        key={r.session}
        // Motion means thinking, amber means your move: working = orbiting
        // green ring (mid-turn, leave it alone); needs = steady amber ring
        // (waiting on the operator — a dialog, an idle prompt, or a dead
        // session); finished = no ring, dimmed.
        className={`runroom-list-item${live ? (r.working ? " working" : " needs") : " finished"}`}
        onClick={() => setSelected(r.session)}
      >
        <span className="runroom-list-brand">
          {wordmark ? (
            <img src={wordmark} alt={r.division} className="runroom-list-mark" />
          ) : (
            <span className="runroom-division-pill" style={{ backgroundColor: colors.bg, color: colors.text }}>
              {r.division || "?"}
            </span>
          )}
        </span>
        <span className="runroom-list-title">{r.title}</span>
        {live && (
          <span className={`runroom-list-state ${r.working ? "working" : r.needs || "input"}`}>
            {r.working ? "thinking…"
              : r.needs === "dialog" ? "decision waiting"
              : r.needs === "gone" ? "session gone"
              : "your move"}
          </span>
        )}
        <span className="runroom-list-meta">
          {r.company} &middot; {r.steps_done}/{r.steps_total}
          {!live && <> &middot; {r.status}</>}
        </span>
      </button>
    );
  };

  return (
    <div className="runroom-list">
      {heading}
      {active.length > 0
        ? active.map(roomItem)
        : <div className="runroom-list-none">No active runrooms.</div>}
      {finished.length > 0 && (
        <>
          <div className="runroom-list-section">Finished</div>
          {finished.map(roomItem)}
        </>
      )}
    </div>
  );
}
