import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { marked } from "marked";
import { DIVISION_COLORS, DIVISION_WORDMARKS } from "../constants.js";
import RoomListCard from "./RoomListCard.jsx";
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

export function RoomHeader({ plan, hasActiveTimer, onOpenProject, onPark }) {
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
        {onPark && plan.status === "active" && (
          <button className="runroom-park-btn" title="Nothing to do right now — wrap this room up; the card's dated next_step brings the work back" onClick={onPark}>
            ⏸ Park
          </button>
        )}
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
        // Chime on the working -> idle edge for finished rooms too: the
        // wrap-up ending is exactly the "you're free now" moment Park waits on.
        if (wasWorking.current === true && !nowWorking) playDoneChime();
        wasWorking.current = nowWorking;
        setPlan(p);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [session]);

  // Park: nothing to do in this room right now. The card keeps a DATED
  // next_step (the calendar + sweeps rebirth the work from it — a fresh plan,
  // a fresh room), and the room is told to wrap itself up through the
  // existing close route, so plan.json stays the session's to write. The
  // close route also covers a dead session (server writes the status then).
  const [park, setPark] = useState(null); // null | { date, action, busy, err }

  const openPark = useCallback(async () => {
    let next = "";
    if (plan?.card_id != null) {
      try {
        const r = await fetch(`/api/projects/${plan.card_id}`);
        if (r.ok) next = (await r.json()).next_step || "";
      } catch {}
    }
    const m = next.match(/^(\d{4}-\d{2}-\d{2})(?:\s+\d{2}:\d{2})?:\s*(.*)$/);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    setPark({
      date: m?.[1] || tomorrow,
      action: (m?.[2] || next || `Resume: ${plan?.title || ""}`).slice(0, 90),
      busy: false, err: null,
    });
  }, [plan]);

  const doPark = useCallback(async () => {
    if (!park?.date) return;
    setPark((p) => ({ ...p, busy: true, err: null }));
    try {
      if (plan?.card_id != null) {
        await fetch(`/api/projects/${plan.card_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ next_step: `${park.date}: ${park.action}`.slice(0, 100) }),
        });
      }
      const r = await fetch(`/api/runrooms/${encodeURIComponent(session)}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: `parked until ${park.date} — the card's next_step brings it back` }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
      setPark(null);
      fetchPlan();
    } catch (e) {
      setPark((p) => (p ? { ...p, busy: false, err: e.message } : p));
    }
  }, [park, plan, session, fetchPlan]);

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
  // Finished on paper, but the session is still visibly closing out — either
  // mid-turn or holding a dialog. The room stays interactive until this ends.
  const wrappingUp = finished
    && (!!plan.gate?.working || (plan.gate?.reason === "dialog-open" && !!plan.gate?.dialog));
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
      <RoomHeader plan={plan} hasActiveTimer={activeTimerIds?.has(plan.card_id)} onOpenProject={onOpenProject} onPark={openPark} />
      {park && (
        <div className="runroom-park-panel">
          <div className="runroom-park-title">Park this room</div>
          <div className="runroom-park-row">
            <label>Resume on</label>
            <input type="date" value={park.date} disabled={park.busy}
              onChange={(e) => setPark((p) => ({ ...p, date: e.target.value }))} />
            <input className="runroom-park-action" value={park.action} disabled={park.busy}
              maxLength={90}
              onChange={(e) => setPark((p) => ({ ...p, action: e.target.value }))} />
          </div>
          <div className="runroom-park-note">
            Writes the card's next_step (that date drives the calendar and the sweeps —
            the work comes back as a fresh plan), then tells this session to wrap the room up.
          </div>
          {park.err && <div className="runroom-park-err">{park.err}</div>}
          <div className="runroom-park-row">
            <button className="runroom-act primary" disabled={park.busy || !park.date} onClick={doPark}>
              {park.busy ? "Parking…" : "Park it"}
            </button>
            <button className="runroom-act" disabled={park.busy} onClick={() => setPark(null)}>Cancel</button>
          </div>
        </div>
      )}
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
          {wrappingUp && (
            <div className="runroom-wrapup-note">
              The session is still closing out (ledger, timer, drafts) — stay until it
              goes quiet, and answer anything it asks below.
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
          {/* Dialogs and the thinking strip stay live through the wrap-up
              window: close-out can ask questions AFTER the plan flips to
              finished (a timer-estimate dialog), and hiding them here was how
              a parked room silently held a timer open. */}
          {(!finished || wrappingUp) && plan.gate?.reason === "dialog-open" && plan.gate?.dialog && (
            <DialogCard key={plan.gate.dialog.fingerprint} dialog={plan.gate.dialog} endpoints={endpoints} />
          )}
          {(!finished || plan.gate?.working) && <ThinkingStrip working={plan.gate?.working} />}
          {!finished && <Composer gate={plan.gate} endpoints={endpoints} />}
        </main>
      </div>
    </div>
  );
}

export default function Runroom({ activeTimerIds, me, onOpenProject, initialSession = null }) {
  const [rooms, setRooms] = useState(null); // null = loading
  // A caller that just opened a room (the Spark/Planroom handoff) names it;
  // otherwise the single-active-room heuristic below decides. Before this the
  // session name SparkPanel passed was dropped and two active rooms landed the
  // operator on the list.
  const [selected, setSelected] = useState(initialSession);
  const [autoOpened, setAutoOpened] = useState(!!initialSession);
  const [showResolved, setShowResolved] = useState(false);
  // Two-click confirm for "Complete card": holds the session whose button is
  // armed; any other click (or completing) disarms it.
  const [confirmComplete, setConfirmComplete] = useState(null);

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

  // Completing the card resolves every room bound to it (the card is the
  // ledger of the work); the existing PATCH machinery also pushes the
  // Completed status to Notion. The refreshed list moves the room into the
  // collapsed Resolved section — that movement is the confirmation.
  const completeCard = useCallback((cardId) => {
    setConfirmComplete(null);
    fetch(`/api/projects/${cardId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    }).then(() => fetchRooms()).catch(() => {});
  }, [fetchRooms]);

  useEffect(() => {
    fetchRooms();
    const t = setInterval(fetchRooms, 5000);
    return () => clearInterval(t);
  }, [fetchRooms]);

  // Exactly one open (unresolved) room → it is almost certainly why the
  // operator is here, so open it. Only once, so backing out to the list
  // sticks. Resolved rooms (own status, or card completed) never auto-open.
  useEffect(() => {
    if (autoOpened || selected || !rooms) return;
    const open = rooms.filter((r) => r.status === "active" && !r.resolved);
    if (open.length === 1) { setSelected(open[0].session); setAutoOpened(true); }
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

  // "Open" = the room's own plan is active AND its card isn't completed; the
  // server derives `resolved` from both. Resolved rooms collapse at the
  // bottom — history worth keeping, not clutter worth scrolling.
  const open = (rooms || []).filter((r) => !r.resolved);
  const resolvedRooms = (rooms || []).filter((r) => r.resolved);

  const heading = (
    <header className="runroom-list-header">
      <h1 className="runroom-list-heading">Runrooms</h1>
      <span className="runroom-list-count">
        {open.length} open{resolvedRooms.length > 0 && <> &middot; {resolvedRooms.length} resolved</>}
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

  // Shared card (RoomListCard) with the runroom ring grammar: motion means
  // thinking, amber means your move — working = orbiting green ring (mid-turn,
  // leave it alone); needs = steady amber ring (waiting on the operator — a
  // dialog, an idle prompt, or a dead session); resolved = no ring, dimmed.
  // Quick actions live in a rail BESIDE the card, not inside it — the card is
  // itself a <button>, and nesting interactive elements breaks clicks.
  const roomItem = (r) => {
    const live = r.status === "active" && !r.resolved;
    return (
      <div className="room-card-row" key={r.session}>
        <RoomListCard
          ringClass={live ? (r.working ? " working" : " needs") : " finished"}
          onClick={() => setSelected(r.session)}
          division={r.division}
          company={r.company}
          title={r.title}
          stateClass={live ? (r.working ? "working" : r.needs || "input") : ""}
          stateLabel={live
            ? (r.working ? "thinking…"
              : r.needs === "dialog" ? "decision waiting"
              : r.needs === "gone" ? "session gone"
              : "your move")
            : ""}
          metaParts={[
            `${r.steps_done}/${r.steps_total} steps`,
            r.resolved ? (r.card_status === "completed" ? "card completed" : r.status) : "",
          ]}
        />
        {r.card_id != null && (
          <span className="room-card-actions">
            {onOpenProject && (
              <button className="room-act" title={`Open card #${r.card_id}`}
                onClick={() => onOpenProject(r.card_id)}>
                Card #{r.card_id}
              </button>
            )}
            {r.card_status && r.card_status !== "completed" && (
              confirmComplete === r.session ? (
                <button className="room-act confirm" onClick={() => completeCard(r.card_id)}>
                  Confirm ✓
                </button>
              ) : (
                <button className="room-act" title="Mark the card completed — resolves this room"
                  onClick={() => setConfirmComplete(r.session)}>
                  ✓ Complete
                </button>
              )
            )}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="runroom-list">
      {heading}
      {open.length > 0
        ? open.map(roomItem)
        : <div className="runroom-list-none">No open runrooms.</div>}
      {resolvedRooms.length > 0 && (
        <>
          <button className="runroom-resolved-toggle" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "▾" : "▸"} Resolved ({resolvedRooms.length})
          </button>
          {showResolved && resolvedRooms.map(roomItem)}
        </>
      )}
    </div>
  );
}
