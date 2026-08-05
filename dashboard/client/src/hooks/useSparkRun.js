import { useCallback, useEffect, useRef, useState } from "react";

// Owned by CardModal, not by SparkPanel.
//
// The panel unmounts whenever the tab changes (the modal renders panels as
// `{tab === "spark" && ...}`), so a run's state has to live above it or every
// glance at the Details tab would drop the stream. CardModal itself only
// remounts when the card changes, which is exactly the right lifetime.

const FRONT_ORDER = ["timers", "notion", "email", "voice", "chat", "artifacts"];

// States where the pane is claiming work is happening — the only ones where a
// dead stream is a lie worth correcting.
const RUNNING = new Set(["scanning", "acting", "proposing", "wrapping"]);
// The server pings every 20s; give it two beats plus slack before calling it.
const STALE_MS = 50_000;

function emptyState() {
  return {
    // idle | scanning | proposing | acting | wrapping | done | error | cancelled
    status: "idle",
    runId: null,
    fronts: null,
    verb: null,
    ledger: [],
    actions: [],
    actionStates: {},
    handoffs: [],
    drafts: [],
    completed: [],
    ballMoved: null,
    round: 0,
    roundsUsed: 0,
    roundsMax: 4,
    result: null,
    error: null,
    accruedMinutes: 0,
    accrualPaused: false,
    idleWrapAt: null,
    timerStarted: false,
    timerNote: null,
    costUsd: null,
    model: null,
    startedAt: null,
    elapsedSec: 0,
    viewingPast: null,   // ISO date when showing a past run rather than a live one
  };
}

export default function useSparkRun(projectId) {
  const [state, setState] = useState(emptyState);
  const [lastRun, setLastRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // True only for a result that arrived live in this session — a replayed
  // result must not re-run the typewriter.
  const [liveResult, setLiveResult] = useState(false);
  const esRef = useRef(null);
  const staleRef = useRef(null);

  const applyRun = useCallback((run) => {
    if (!run) return;
    setState((s) => ({
      ...s,
      status: run.status || s.status,
      runId: run.id ?? s.runId,
      fronts: run.fronts ?? s.fronts,
      verb: run.verb ?? s.verb,
      ledger: run.ledger ?? s.ledger,
      result: run.result ?? s.result,
      error: run.error ?? s.error,
      actions: run.actions ?? s.actions,
      actionStates: run.actionStates ?? s.actionStates,
      handoffs: run.handoffs ?? s.handoffs,
      drafts: run.drafts ?? s.drafts,
      completed: run.completed ?? s.completed,
      ballMoved: run.ballMoved ?? s.ballMoved,
      round: run.round ?? s.round,
      roundsUsed: run.roundsUsed ?? s.roundsUsed,
      roundsMax: run.roundsMax ?? s.roundsMax,
      accruedMinutes: run.accruedMinutes ?? s.accruedMinutes,
      accrualPaused: run.accrualPaused ?? s.accrualPaused,
      idleWrapAt: run.idleWrapAt ?? s.idleWrapAt,
      timerStarted: run.timerStarted ?? s.timerStarted,
      timerNote: run.timerNote ?? s.timerNote,
      costUsd: run.costUsd ?? s.costUsd,
      model: run.model ?? s.model,
      startedAt: run.startedAt ?? s.startedAt,
      elapsedSec: run.elapsedSec ?? s.elapsedSec,
    }));
  }, []);

  const closeStream = useCallback(() => {
    clearTimeout(staleRef.current);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const openStream = useCallback(() => {
    if (esRef.current) return;
    const es = new EventSource(`/api/projects/${projectId}/spark/stream`);
    esRef.current = es;

    // Any frame at all proves the stream is alive. The server pings every 20s,
    // so silence past that window means the connection is gone — which is the
    // state that used to be indistinguishable from "still thinking".
    const beat = () => {
      clearTimeout(staleRef.current);
      staleRef.current = setTimeout(() => {
        setState((s) => (RUNNING.has(s.status)
          ? { ...s, status: "interrupted",
              error: { message: "Lost the connection to the dashboard mid-run. "
                              + "The run may have been stopped by a restart." } }
          : s));
      }, STALE_MS);
    };

    const on = (name, fn) => es.addEventListener(name, (e) => {
      beat();
      let data = null;
      try { data = JSON.parse(e.data); } catch { return; }
      fn(data);
    });
    on("ping", () => {});

    on("snapshot", (d) => {
      if (d.status === "idle") {
        // Reconnected, and the server has no run. If we were showing one, it
        // did not survive — say so rather than leaving a frozen checklist up.
        closeStream();
        setState((s) => (RUNNING.has(s.status)
          ? { ...s, status: "interrupted",
              error: { message: "The run was interrupted before it finished — "
                              + "most likely the dashboard restarted. Nothing was recorded." } }
          : s));
        return;
      }
      applyRun(d);
    });
    on("phase", (d) => setState((s) => ({
      ...s,
      fronts: { ...(s.fronts || {}), [d.front]: { state: d.state, detail: d.detail } },
    })));
    on("thinking", (d) => setState((s) => ({ ...s, verb: d.verb })));
    on("timer", (d) => setState((s) => ({
      ...s,
      timerStarted: !!d.started,
      timerNote: d.started ? null : d.reason,
      accruedMinutes: d.accrued ?? s.accruedMinutes,
    })));
    on("ledger", (d) => setState((s) => ({ ...s, ledger: [...s.ledger, d] })));
    on("actions", (d) => setState((s) => ({
      ...s,
      status: "proposing",
      actions: d.items || [],
      handoffs: d.handoffs || [],
      actionStates: Object.fromEntries((d.items || []).map((a) => [a.id, { state: "pending" }])),
    })));
    on("action_progress", (d) => setState((s) => ({
      ...s,
      actionStates: { ...s.actionStates, [d.id]: { state: d.state, detail: d.detail } },
    })));
    on("draft", (d) => setState((s) => ({
      ...s,
      drafts: s.drafts.some((x) => x.id === d.id)
        ? s.drafts.map((x) => (x.id === d.id ? d : x))
        : [...s.drafts, d],
    })));
    on("ball_moved", (d) => setState((s) => ({ ...s, ballMoved: d.text })));
    on("result", (d) => { setLiveResult(true); setState((s) => ({ ...s, result: d })); });
    on("error", (d) => setState((s) => ({ ...s, error: d, status: "error" })));
    on("end", (d) => {
      setState((s) => ({
        ...s,
        status: d.status,
        costUsd: d.costUsd ?? s.costUsd,
        elapsedSec: d.elapsedSec ?? s.elapsedSec,
        accruedMinutes: d.accruedMinutes ?? s.accruedMinutes,
      }));
      closeStream();
    });

    // The browser reconnects EventSource automatically; the server always
    // answers with a full snapshot, so a reconnect self-heals.
    es.onerror = () => {
      // EventSource retries on its own; only a CLOSED socket is terminal.
      if (es.readyState !== EventSource.CLOSED) return;
      esRef.current = null;
      setState((s) => (RUNNING.has(s.status)
        ? { ...s, status: "interrupted",
            error: { message: "Lost the connection to the dashboard mid-run." } }
        : s));
    };
  }, [projectId, applyRun, closeStream]);

  // Initial snapshot — cheap, and tells us whether to attach to a live run.
  useEffect(() => {
    let cancelled = false;
    setState(emptyState());
    setLastRun(null);
    setHistory([]);
    setLiveResult(false);
    setLoading(true);
    fetch(`/api/projects/${projectId}/spark`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setLastRun(d.lastRun || null);
        setState((s) => ({ ...s, model: d.model || s.model, canStart: d.canStart }));
        if (d.run) {
          applyRun(d.run);
          if (!d.run.finishedAt) openStream();
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; closeStream(); };
  }, [projectId, applyRun, openStream, closeStream]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/spark`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { error: body.error || `HTTP ${res.status}` };
      setState({ ...emptyState(), status: "scanning", runId: body.runId, startedAt: Date.now() });
      setLiveResult(false);
      openStream();
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    } finally {
      setBusy(false);
    }
  }, [projectId, openStream]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/projects/${projectId}/spark`, { method: "DELETE" });
    } catch {} finally { setBusy(false); }
  }, [projectId]);

  const decide = useCallback(async (decisions) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/spark/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { error: body.error || `HTTP ${res.status}` };
      setState((s) => ({ ...s, status: body.started ? "acting" : "wrapping" }));
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    } finally { setBusy(false); }
  }, [projectId]);

  const sendDraft = useCallback(async (draftId) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/spark/send-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { error: body.error || `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    } finally { setBusy(false); }
  }, [projectId]);

  const handoff = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/spark/handoff`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { error: body.error || `HTTP ${res.status}` };
      return { ok: true, brief: body.brief };
    } catch (err) {
      return { error: err.message };
    } finally { setBusy(false); }
  }, [projectId]);

  const showLastRun = useCallback(() => {
    if (!lastRun?.result) return;
    setLiveResult(false);
    setState((s) => ({ ...s, status: "done", result: lastRun.result, viewingPast: lastRun.at }));
  }, [lastRun]);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${projectId}/spark/history`);
      const items = await r.json();
      setHistory(Array.isArray(items) ? items : []);
      return items;
    } catch { return []; }
  }, [projectId]);

  // Past runs are kept on disk forever, so an old report can always be reopened.
  const showRun = useCallback(async (runId) => {
    try {
      const r = await fetch(`/api/projects/${projectId}/spark/history/${runId}`);
      if (!r.ok) return;
      const d = await r.json();
      setLiveResult(false);
      setState((s) => ({ ...s, status: "done", result: d.result, viewingPast: d.at }));
    } catch {}
  }, [projectId]);

  const backToIdle = useCallback(() => {
    setState((s) => ({ ...s, status: "idle", result: null, viewingPast: null }));
  }, []);

  return {
    ...state,
    fronts: state.fronts,
    frontOrder: FRONT_ORDER,
    lastRun,
    history,
    loading,
    busy,
    liveResult,
    start,
    cancel,
    decide,
    sendDraft,
    handoff,
    showLastRun,
    loadHistory,
    showRun,
    backToIdle,
  };
}
