import { useState, useEffect, useCallback } from "react";
import { StateGlyph } from "./runroom/shared.jsx";
import RoomListCard from "./RoomListCard.jsx";
import { RoomHeader } from "./Runroom.jsx";
import SparkPanel from "./SparkPanel.jsx";
import useSparkRun from "../hooks/useSparkRun.js";

// Planrooms — the standing plan per card, in the room shape.
//
// This is the Plan stage of the loop the product is built around: Plan → Run
// → Mail. A runroom is a plan walked by a live session; a planroom is the plan
// BEFORE it has a session — Spark writes it, the operator reads it here and
// decides, and "Open a runroom" hands it to Run. So the layout is the
// runroom's (header, rail, main) with the spark report where the step pane
// would be, and no composer: there is no session to talk to.
//
// Two data sources, deliberately: the plan on disk (polled, like runrooms) and
// the live spark run (SSE via useSparkRun, like the card modal). The run is
// authoritative while it lives; the plan is what remains when it ends.

function rel(iso) {
  if (!iso) return "";
  const t = new Date(iso.length === 16 ? `${iso}:00` : iso).getTime();
  if (Number.isNaN(t)) return iso;
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function stateLabel(r) {
  if (r.live?.status === "proposing") return ["decision waiting", "needs"];
  if (r.live) return ["scanning…", "working"];
  if (r.status === "adopted") return [`in runroom ${r.adopted_by?.tmux_session || ""}`, "adopted"];
  if (r.stale) return ["stale", "finished"];
  return ["ready", ""];
}

// ── one planroom ────────────────────────────────────────────────────────────

function PlanroomView({ cardId, activeTimerIds, me, onOpenProject, onBack, showBack, onGoToRunroom, showToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const spark = useSparkRun(cardId);

  const refresh = useCallback(() => {
    fetch(`/api/planrooms/${cardId}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); })
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message));
  }, [cardId]);

  // The plan file moves when a scan or a round finishes, and when a runroom
  // the plan was adopted into advances a step — 5s is plenty for both.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);
  // And immediately when the live run changes state — no waiting a poll.
  useEffect(() => { refresh(); }, [spark.status, refresh]);

  async function adopt() {
    try {
      const r = await fetch(`/api/planrooms/${cardId}/adopt`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return showToast(d?.error || `HTTP ${r.status}`);
      showToast(`Runroom open in ${d.session}`);
      refresh();
      onGoToRunroom?.(d.session);
    } catch (e) {
      showToast(e.message);
    }
  }

  if (error) return <div className="runroom-room"><p className="runroom-error">{error}</p></div>;
  if (!data) return <div className="loading">Loading planroom...</div>;

  const { card, plan, runroom } = data;
  const adopted = plan?.status === "adopted" && runroom;
  // While adopted, the rail shows the RUNROOM's steps — the session owns the
  // live document and this page reads through to it. Otherwise the plan's own.
  const steps = adopted ? runroom.steps : (plan?.steps || []);
  const currentN = adopted ? runroom.current_step : plan?.current_step;

  // RoomHeader wants a plan-shaped object; an unsparked card gets a stub so the
  // page still has its insignia and a Card link.
  const headerPlan = plan
    ? { ...plan, steps, current_step: currentN, status: adopted ? runroom.status : plan.status, plan_mtime: adopted ? runroom.plan_mtime : undefined }
    : {
        title: `${card.name} — no plan yet`, card_id: card.id, card_name: card.name,
        company: card.company_name || "", division: card.division || "",
        status: "active", steps: [], current_step: null, created: "",
      };

  return (
    <div className="runroom-room planroom-room">
      {showBack && <button className="runroom-back" onClick={onBack}>&larr; all planrooms</button>}
      <RoomHeader plan={headerPlan} hasActiveTimer={activeTimerIds?.has(card.id)} onOpenProject={onOpenProject} />
      <div className="runroom-body">
        <aside className="runroom-rail">
          <div className="runroom-rail-toggle" style={{ cursor: "default" }}>
            {adopted ? "RUNROOM ▾" : "PLAN ▾"}
          </div>
          {steps.length === 0 && (
            <div className="planroom-rail-empty">
              {plan ? "No steps — spark the card." : "Not yet sparked."}
            </div>
          )}
          {steps.map((s) => (
            <div key={s.n} className={`runroom-rail-step${s.n === currentN ? " is-current viewing" : ""}`}>
              <StateGlyph state={s.state} />
              <span className="runroom-rail-title">{s.n}. {s.title}</span>
            </div>
          ))}
        </aside>
        <main className="runroom-main planroom-main">
          {adopted && (
            <div className="planroom-adopted">
              <div>
                <strong>Adopted</strong> into runroom <code>{runroom.session}</code>
                {runroom.current_step != null ? ` · step ${runroom.current_step} of ${runroom.steps.length}` : ""}
                {runroom.status !== "active" ? ` · ${runroom.status}` : ""}
                {plan.adopted_by?.at ? ` · ${rel(plan.adopted_by.at)}` : ""}
              </div>
              <button className="spark-btn" onClick={() => onGoToRunroom?.(runroom.session)}>Open runroom</button>
            </div>
          )}
          <SparkPanel
            spark={spark}
            project={card}
            showToast={showToast}
            onGoToTerminal={() => onOpenProject?.(card.id)}
            onGoToRunroom={(session) => { refresh(); onGoToRunroom?.(session); }}
            onAdopt={adopted ? null : adopt}
            onRefresh={refresh}
            standing={plan?.planroom || null}
            isAdmin={!!me?.is_admin}
          />
        </main>
      </div>
    </div>
  );
}

// ── the list ────────────────────────────────────────────────────────────────

export default function Planroom({ activeTimerIds, me, onOpenProject, initialCardId = null, onGoToRunroom, showToast, onNewTask = null }) {
  const [rooms, setRooms] = useState(null);
  const [selected, setSelected] = useState(initialCardId);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () => fetch(`/api/planrooms${showAll ? "?all=1" : ""}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (!stop) setRooms(Array.isArray(d) ? d : []); })
      .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [showAll]);

  // Follow a caller's choice if it changes underneath us (deep link → another).
  useEffect(() => { if (initialCardId) setSelected(initialCardId); }, [initialCardId]);

  if (selected) {
    return (
      <PlanroomView
        cardId={selected}
        activeTimerIds={activeTimerIds}
        me={me}
        onOpenProject={onOpenProject}
        onBack={() => setSelected(null)}
        showBack
        onGoToRunroom={onGoToRunroom}
        showToast={showToast || (() => {})}
      />
    );
  }

  if (rooms === null) return <div className="loading">Loading planrooms...</div>;

  const heading = (
    <header className="runroom-list-header">
      <h1 className="runroom-list-heading">Planrooms</h1>
      <span className="runroom-list-count">
        {rooms.length} {showAll ? "total" : "in play"}
        {" "}&middot;{" "}
        <button className="planroom-all-toggle" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "working set" : "show all"}
        </button>
      </span>
      {onNewTask && (
        <button className="planroom-new-btn" onClick={onNewTask}>+ New</button>
      )}
    </header>
  );

  if (rooms.length === 0) {
    return (
      <div className="runroom-list">
        {heading}
        <div className="runroom-empty">
          <h2>No plans yet</h2>
          <p>Spark a card — from its Spark tab, or let an ODA sweep find it — and its plan lands here.</p>
        </div>
      </div>
    );
  }

  // Shared card (RoomListCard), same ring grammar as the runroom list:
  // working = scanning, needs = a decision is waiting, finished = adopted/stale.
  const item = (r) => {
    const [label, cls] = stateLabel(r);
    const ring = r.live ? (r.live.status === "proposing" ? " needs" : " working") : (r.status === "adopted" || r.stale ? " finished" : "");
    return (
      <RoomListCard
        key={r.card_id}
        ringClass={ring}
        onClick={() => setSelected(r.card_id)}
        division={r.division}
        company={r.company}
        title={r.title}
        pct={r.certitude}
        stateClass={cls}
        stateLabel={label}
        metaParts={[
          `#${r.card_id}`,
          r.route,
          `sparked ${rel(r.sparked_at)}${r.sparked_by ? ` by ${r.sparked_by.replace(/^agent:/, "")}` : ""}`,
          r.steps_total > 0 ? `${r.steps_done}/${r.steps_total} steps` : "",
        ]}
      />
    );
  };

  const needs = rooms.filter((r) => r.live?.status === "proposing");
  const rest = rooms.filter((r) => r.live?.status !== "proposing");
  return (
    <div className="runroom-list">
      {heading}
      {needs.length > 0 && (
        <>
          <div className="runroom-list-section">Decision waiting</div>
          {needs.map(item)}
        </>
      )}
      {rest.map(item)}
    </div>
  );
}
