import { useState, useEffect, useCallback, useRef } from "react";
import AgentProjectPicker from "./AgentProjectPicker.jsx";
import AgentAvatar from "./AgentAvatar.jsx";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MODELS = ["opus", "sonnet", "haiku"];

// agent_runs timestamps are SQLite datetime('now') — UTC with no zone marker.
// Everything user-facing in OpenDia is Eastern.
function fmtET(sqliteUtc) {
  if (!sqliteUtc) return "";
  const d = new Date(sqliteUtc.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return sqliteUtc;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// Full admin surface for one ODA: every attribute editable in place, the two
// markdown files, assigned cards, the activity feed, and a live heartbeat log
// over SSE while one is running.
export default function AgentDetail({ agentId, projects, onOpenProject, onBack }) {
  const [agent, setAgent] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingFile, setEditingFile] = useState(null);   // "agent_md" | "memory_md"
  const [fileDraft, setFileDraft] = useState("");
  const [expandedRun, setExpandedRun] = useState(null);
  // Collapsible panels: start open; caret-only toggle so the cards
  // header's live Static/Query/+Assign buttons are never swallowed.
  // Persisted per browser (not per agent — a layout preference, not data).
  const [closedPanels, setClosedPanels] = useState(() => {
    try { return JSON.parse(localStorage.getItem("opendia.agentPanelsClosed")) || {}; }
    catch { return {}; }
  });
  const togglePanel = (k) => setClosedPanels((c) => {
    const next = { ...c, [k]: !c[k] };
    try { localStorage.setItem("opendia.agentPanelsClosed", JSON.stringify(next)); } catch {}
    return next;
  });
  // Persona/memory start collapsed — glanceable roster stats first, prose on
  // demand. Editing a file implicitly holds it open.
  const [openFiles, setOpenFiles] = useState({});
  const [liveState, setLiveState] = useState(null);
  const esRef = useRef(null);

  const fetchAgent = useCallback(() => {
    fetch(`/api/agents/${agentId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => { setAgent(data); setError(null); })
      .catch((e) => setError(e.message));
  }, [agentId]);

  useEffect(() => {
    fetchAgent();
    const t = setInterval(fetchAgent, 15000);
    return () => clearInterval(t);
  }, [fetchAgent]);

  // Live heartbeat log: connect whenever the agent reports an active run.
  useEffect(() => {
    if (!agent?.active) {
      esRef.current?.close();
      esRef.current = null;
      setLiveState(agent?.live || null);
      return;
    }
    if (esRef.current) return;
    const es = new EventSource(`/api/agents/${agentId}/stream`);
    esRef.current = es;
    const update = (e) => { try { setLiveState(JSON.parse(e.data)); } catch {} };
    es.addEventListener("snapshot", update);
    es.addEventListener("progress", update);
    es.addEventListener("log", (e) => {
      try {
        const entry = JSON.parse(e.data);
        setLiveState((s) => (s ? { ...s, log: [...(s.log || []), entry].slice(-50) } : s));
      } catch {}
    });
    es.addEventListener("done", () => {
      es.close();
      esRef.current = null;
      setLiveState(null);
      fetchAgent();
    });
    es.onerror = () => { es.close(); esRef.current = null; };
    return () => { es.close(); esRef.current = null; };
  }, [agent?.active, agentId, fetchAgent]);

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function patch(fields) {
    try {
      const r = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      fetchAgent();
    } catch (e) {
      flash(`Save failed: ${e.message}`);
    }
  }

  function toggleDay(day) {
    const days = String(agent.schedule_days || "").split(",").map(Number).filter((n) => !Number.isNaN(n));
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
    if (next.length === 0) return;   // an agent with no working days is just disabled
    patch({ schedule_days: next.join(",") });
  }

  async function assignProject(projectId) {
    setPickerOpen(false);
    await fetch(`/api/agents/${agentId}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    });
    fetchAgent();
  }

  async function unassignProject(projectId) {
    await fetch(`/api/agents/${agentId}/projects/${projectId}`, { method: "DELETE" });
    fetchAgent();
  }

  async function runNow() {
    const r = await fetch(`/api/agents/${agentId}/heartbeat`, { method: "POST" });
    if (r.status === 409) flash("A heartbeat is already running.");
    else if (!r.ok) flash("Could not start heartbeat.");
    else flash("Heartbeat started.");
    fetchAgent();
  }

  async function requestStatus() {
    flash("Asking for a status update…");
    try {
      const r = await fetch(`/api/agents/${agentId}/status-request`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fetchAgent();
      flash("Status update posted to the feed.");
    } catch {
      flash("Status request failed.");
    }
  }

  async function saveFile() {
    try {
      const r = await fetch(`/api/agents/${agentId}/files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [editingFile]: fileDraft }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setEditingFile(null);
      fetchAgent();
    } catch (e) {
      flash(`Save failed: ${e.message}`);
    }
  }

  if (error) {
    return (
      <div className="agents-view">
        <button className="agents-back" onClick={onBack}>← All agents</button>
        <div className="agents-error">Agent API error: {error}</div>
      </div>
    );
  }
  if (!agent) return <div className="loading">Loading agent...</div>;

  const days = String(agent.schedule_days || "").split(",").map(Number);
  const memoryWarn = agent.memory_lines >= 80;
  const live = liveState || agent.live;
  const isQuery = agent.roster_mode === "query";
  const isSupervisor = agent.role === "supervisor";
  const queryStatuses = String(agent.query_status || "").split(",").map((s) => s.trim()).filter(Boolean);

  function toggleQueryStatus(s) {
    const next = queryStatuses.includes(s)
      ? queryStatuses.filter((x) => x !== s)
      : [...queryStatuses, s];
    patch({ query_status: next.join(",") });
  }

  const dot = !agent.enabled
    ? { cls: "disabled", label: "disabled" }
    : agent.active
      ? { cls: "working", label: agent.current_project ? `working — ${agent.current_project.name}` : "working" }
      : agent.in_window
        ? { cls: "idle", label: "idle — in window" }
        : { cls: "off", label: `next window ${agent.schedule_start} ET` };

  // At-a-glance week: computed from the runs the view already fetched.
  const weekAgo = Date.now() - 7 * 86400 * 1000;
  const weekRuns = (agent.runs || []).filter(
    (r) => r.finished_at && new Date(r.started_at.replace(" ", "T") + "Z").getTime() > weekAgo
  );
  const weekTokens = weekRuns.reduce((n, r) => n + (r.tokens_used || 0), 0);
  const weekCost = weekRuns.reduce((n, r) => n + (r.cost_usd || 0), 0);

  return (
    <div className="agents-view agents-detail">
      <div className="agents-detail-header">
        <button className="agents-back" onClick={onBack}>← All agents</button>
      </div>

      <div className="agent-hero">
        <AgentAvatar slug={agent.slug} name={agent.name} size="hero" />
        <div className="agent-hero-id">
          <h2 className="agent-hero-name">
            {agent.name}
            {isSupervisor && <span className="agents-role-badge">supervisor</span>}
          </h2>
          <div className="agent-hero-status">
            <span className={`agents-dot ${dot.cls}`} />
            <span>{dot.label}</span>
          </div>
        </div>
        <div className="agent-hero-actions">
          <button onClick={runNow} disabled={agent.active}>Run now</button>
          <button onClick={requestStatus}>Request status</button>
          <label className="switch" title={agent.enabled ? "Enabled" : "Disabled"}>
            <input
              type="checkbox"
              checked={!!agent.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span className="switch-track" />
            Enabled
          </label>
        </div>
        <div className="agent-hero-stats">
          <div className="agent-stat">
            <span className="agent-stat-value">{weekRuns.length}</span>
            <span className="agent-stat-label">runs · 7d</span>
          </div>
          <div className="agent-stat">
            <span className="agent-stat-value">{weekTokens.toLocaleString()}</span>
            <span className="agent-stat-label">tokens · 7d</span>
          </div>
          <div className="agent-stat">
            <span className="agent-stat-value">${weekCost.toFixed(2)}</span>
            <span className="agent-stat-label">cost · 7d</span>
          </div>
          <div className="agent-stat">
            <span className="agent-stat-value">{agent.pending_approvals ?? 0}</span>
            <span className="agent-stat-label">awaiting decision</span>
          </div>
          <div className="agent-stat">
            <span className="agent-stat-value">{agent.schedule_start}–{agent.schedule_end}</span>
            <span className="agent-stat-label">window · ET</span>
          </div>
        </div>
      </div>

      {live && (
        <div className="agents-live">
          <div className="agents-live-head">
            Heartbeat running — {live.cardsDone}/{live.cardsTotal} cards,{" "}
            {(live.tokens || 0).toLocaleString()} tokens, ${(live.costUsd || 0).toFixed(2)}
            {live.currentProject && <span className="agents-current"> → {live.currentProject.name}</span>}
          </div>
          <div className="agents-live-log">
            {(live.log || []).slice(-10).map((l, i) => (
              <div key={i} className={`agents-live-line ${l.level}`}>{l.text}</div>
            ))}
          </div>
        </div>
      )}

      <div className="agents-detail-grid">
        <section className="agents-panel agents-panel-wide">
          <h3><button className="agents-collapse-caret" title="Collapse / expand" onClick={() => togglePanel("settings")}>{closedPanels.settings ? "▸" : "▾"}</button>Settings</h3>
          {!closedPanels.settings && (<>

          <div className="agents-group">
            <div className="agents-group-title">Schedule</div>
            <div className="agents-group-fields">
              <div className="agents-field agents-field-span">
                <label>Working days</label>
                <div className="agents-day-chips">
                  {DAY_LABELS.map((label, day) => (
                    <button
                      key={day}
                      className={`agents-day-chip${days.includes(day) ? " on" : ""}`}
                      onClick={() => toggleDay(day)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="agents-field">
                <label>Start (ET)</label>
                <input
                  type="time" autoComplete="off" data-form-type="other"
                  defaultValue={agent.schedule_start}
                  onBlur={(e) => e.target.value !== agent.schedule_start && patch({ schedule_start: e.target.value })}
                />
              </div>
              <div className="agents-field">
                <label>End (ET)</label>
                <input
                  type="time" autoComplete="off" data-form-type="other"
                  defaultValue={agent.schedule_end}
                  onBlur={(e) => e.target.value !== agent.schedule_end && patch({ schedule_end: e.target.value })}
                />
              </div>
              <div className="agents-field">
                <label>Every (min)</label>
                <input
                  type="number" min="5" step="5" autoComplete="off" data-form-type="other"
                  defaultValue={agent.heartbeat_minutes}
                  onBlur={(e) => Number(e.target.value) !== agent.heartbeat_minutes && patch({ heartbeat_minutes: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>

          <div className="agents-group">
            <div className="agents-group-title">Brain</div>
            <div className="agents-group-fields">
              <div className="agents-field">
                <label>Model</label>
                <select value={agent.model} onChange={(e) => patch({ model: e.target.value })}>
                  {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="agents-field">
                <label>Role</label>
                <select value={agent.role} onChange={(e) => patch({ role: e.target.value })}>
                  <option value="scanner">scanner</option>
                  <option value="supervisor">supervisor</option>
                </select>
              </div>
            </div>
          </div>

          <div className="agents-group">
            <div className="agents-group-title">Limits</div>
            <div className="agents-group-fields">
              <div className="agents-field">
                <label>Tokens / heartbeat</label>
                <input
                  type="number" min="1000" step="1000" autoComplete="off" data-form-type="other"
                  defaultValue={agent.heartbeat_token_limit}
                  onBlur={(e) => Number(e.target.value) !== agent.heartbeat_token_limit && patch({ heartbeat_token_limit: Number(e.target.value) })}
                />
              </div>
              <div className="agents-field">
                <label>Budget / card (USD)</label>
                <input
                  type="number" min="0.25" step="0.25" autoComplete="off" data-form-type="other"
                  defaultValue={agent.run_budget_usd}
                  onBlur={(e) => Number(e.target.value) !== agent.run_budget_usd && patch({ run_budget_usd: Number(e.target.value) })}
                />
              </div>
              <div className="agents-field">
                <label>Cards / heartbeat (0 = all)</label>
                <input
                  type="number" min="0" step="1" autoComplete="off" data-form-type="other"
                  defaultValue={agent.max_cards_per_heartbeat}
                  onBlur={(e) => Number(e.target.value) !== agent.max_cards_per_heartbeat && patch({ max_cards_per_heartbeat: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>

          {isSupervisor && (
            <div className="agents-group">
              <div className="agents-group-title">Supervision</div>
              <div className="agents-group-fields">
                <div className="agents-field">
                  <label>Min certitude to approve</label>
                  <input
                    type="number" min="0" max="100" step="5" autoComplete="off" data-form-type="other"
                    defaultValue={agent.min_certitude}
                    onBlur={(e) => Number(e.target.value) !== agent.min_certitude && patch({ min_certitude: Number(e.target.value) })}
                  />
                </div>
                <div className="agents-field">
                  <label>Max approvals / pass</label>
                  <input
                    type="number" min="0" step="1" autoComplete="off" data-form-type="other"
                    defaultValue={agent.max_auto_approvals}
                    onBlur={(e) => Number(e.target.value) !== agent.max_auto_approvals && patch({ max_auto_approvals: Number(e.target.value) })}
                  />
                </div>
                <div className="agents-field">
                  <label>Mode</label>
                  <label className="switch" title="Shadow reviews and escalates only, recording what it would have approved.">
                    <input
                      type="checkbox"
                      checked={!!agent.autopilot}
                      onChange={(e) => patch({ autopilot: e.target.checked })}
                    />
                    <span className="switch-track" />
                    {agent.autopilot ? "Autopilot — approve within guardrails" : "Shadow — review & escalate only"}
                  </label>
                </div>
              </div>
            </div>
          )}

          <div className="agents-group">
            <div className="agents-group-title">Notifications</div>
            <div className="agents-group-fields">
              <div className="agents-field">
                <label>Chat</label>
                <select value={agent.chat_mode} onChange={(e) => patch({ chat_mode: e.target.value })}>
                  <option value="per_heartbeat">per heartbeat</option>
                  <option value="quiet">quiet</option>
                  <option value="digest">window digest</option>
                </select>
              </div>
              <div className="agents-field agents-field-grow">
                <label>Webhook URL (blank = global)</label>
                <input
                  type="text" autoComplete="off" data-form-type="other"
                  defaultValue={agent.chat_webhook_url || ""}
                  placeholder="https://chat.googleapis.com/v1/spaces/…"
                  onBlur={(e) => (e.target.value || null) !== agent.chat_webhook_url && patch({ chat_webhook_url: e.target.value || null })}
                />
              </div>
            </div>
          </div>
          </>)}
        </section>

        {!isSupervisor && (
        <section className="agents-panel agents-panel-wide">
          <h3><button className="agents-collapse-caret" title="Collapse / expand" onClick={() => togglePanel("cards")}>{closedPanels.cards ? "▸" : "▾"}</button>
            {isQuery ? `Matching cards (${agent.projects.length} right now)` : `Assigned cards (${agent.projects.length})`}
            <span className="agents-roster-toggle">
              <button
                className={`agents-day-chip${!isQuery ? " on" : ""}`}
                onClick={() => agent.roster_mode !== "static" && patch({ roster_mode: "static" })}
              >
                Static
              </button>
              <button
                className={`agents-day-chip${isQuery ? " on" : ""}`}
                onClick={() => agent.roster_mode !== "query" && patch({ roster_mode: "query" })}
              >
                Query
              </button>
            </span>
            {!isQuery && (
              <button className="agents-assign-btn" onClick={() => setPickerOpen(true)}>+ Assign</button>
            )}
          </h3>
          {!closedPanels.cards && (<>
          {isQuery && (
            <div className="agents-query-controls">
              <div className="agents-field">
                <label>Card statuses</label>
                <div className="agents-day-chips">
                  {["in_progress", "wfhuman", "ice", "completed"].map((s) => (
                    <button
                      key={s}
                      className={`agents-day-chip${queryStatuses.includes(s) ? " on" : ""}`}
                      onClick={() => toggleQueryStatus(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div className="agents-field">
                <label>Next-step date filter</label>
                <select
                  value={agent.query_next_step}
                  onChange={(e) => patch({ query_next_step: e.target.value })}
                >
                  <option value="any">any — no date filter</option>
                  <option value="stale">stale — overdue or undated</option>
                  <option value="due">due — dated, today or past</option>
                </select>
              </div>
              <label className="switch" title="A cheap model pass judges the full match list for quick wins first; only confident picks get real scans.">
                <input
                  type="checkbox"
                  checked={!!agent.triage}
                  onChange={(e) => patch({ triage: e.target.checked })}
                />
                <span className="switch-track" />
                Triage quick wins before scanning
              </label>
              <label className="switch" title="Only cards with a real client Company set — Linnflux-internal and unassigned cards are excluded.">
                <input
                  type="checkbox"
                  checked={!!agent.query_client_only}
                  onChange={(e) => patch({ query_client_only: e.target.checked })}
                />
                <span className="switch-track" />
                Client deliverables only
              </label>
            </div>
          )}
          {agent.projects.length === 0 ? (
            <div className="agents-empty">
              {isQuery ? "No cards match the query right now." : "No cards assigned — the agent has nothing to work from."}
            </div>
          ) : (
            <ul className="agents-project-list">
              {agent.projects.map((p) => (
                <li key={p.id}>
                  <button className="agents-project-link" onClick={() => onOpenProject?.(p.id)}>
                    {p.name}
                  </button>
                  <span className="agents-project-meta">{p.company_short || p.company_name || ""} · {p.status}</span>
                  {p.next_step && <span className="agents-project-next" title={p.next_step}>{p.next_step}</span>}
                  {!isQuery && (
                    <button className="agents-remove-btn" onClick={() => unassignProject(p.id)} title="Unassign">×</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          </>)}
        </section>
        )}

        {["agent_md", "memory_md"].map((fileKey) => {
          const open = openFiles[fileKey] || editingFile === fileKey;
          return (
          <section className="agents-panel agents-panel-file" key={fileKey}>
            <h3>
              <button
                className="agents-file-toggle"
                aria-expanded={open}
                onClick={() => setOpenFiles((s) => ({ ...s, [fileKey]: !open }))}
              >
                <span className={`agents-file-chevron${open ? " open" : ""}`}>▸</span>
                {fileKey === "agent_md" ? "Persona & expertise (agent.md)" : `Memory (memory.md · ${agent.memory_lines} lines)`}
              </button>
              {fileKey === "memory_md" && memoryWarn && (
                <span className="agents-memory-warn">over 80 lines — needs pruning</span>
              )}
              {open && (editingFile === fileKey ? (
                <span className="agents-file-actions">
                  <button onClick={saveFile}>Save</button>
                  <button onClick={() => setEditingFile(null)}>Cancel</button>
                </span>
              ) : (
                <button
                  className="agents-edit-btn"
                  onClick={() => { setEditingFile(fileKey); setFileDraft(agent[fileKey]); }}
                >
                  Edit
                </button>
              ))}
            </h3>
            {open && (editingFile === fileKey ? (
              <textarea
                className="agents-file-editor"
                value={fileDraft}
                onChange={(e) => setFileDraft(e.target.value)}
                rows={14}
              />
            ) : (
              <pre className="agents-file-view">{agent[fileKey] || "(empty)"}</pre>
            ))}
          </section>
          );
        })}

        <section className="agents-panel agents-feed">
          <h3>Activity</h3>
          {agent.runs.length === 0 ? (
            <div className="agents-empty">No heartbeats yet.</div>
          ) : (
            <ul className="agents-run-list">
              {agent.runs.map((r) => {
                // Scanner heartbeats store an ARRAY of per-card entries;
                // supervisor reviews store an OBJECT {approved, escalated,…}.
                // Both audit differently, so both get their own expansion.
                let detail = null;
                try { detail = JSON.parse(r.detail || "null"); } catch {}
                const scanCards = Array.isArray(detail) ? detail : null;
                const review = !Array.isArray(detail) && detail
                  && (detail.approved?.length || detail.escalated?.length) ? detail : null;
                const expandable = (scanCards && scanCards.length > 0) || !!review;
                const open = expandedRun === r.id && expandable;
                const cert = (v) => Number.isInteger(v)
                  ? <span className="agents-run-certitude">{v}%</span> : null;
                return (
                  <li key={r.id} className={`agents-run status-${r.status}`}>
                    <button
                      className={`agents-run-head${expandable ? "" : " inert"}`}
                      onClick={() => expandable && setExpandedRun(open ? null : r.id)}
                    >
                      <span className={`agents-run-status ${r.status}`}>{r.status}</span>
                      <span className="agents-run-when">{fmtET(r.started_at)}</span>
                      <span className="agents-run-summary">{r.summary || r.trigger}</span>
                      {r.tokens_used > 0 && (
                        <span className="agents-run-cost">{r.tokens_used.toLocaleString()} tok · ${(r.cost_usd || 0).toFixed(2)}</span>
                      )}
                    </button>
                    {open && scanCards && (
                      <ul className="agents-run-detail">
                        {scanCards.map((d, i) => (
                          <li key={i}>
                            <button className="agents-project-link" onClick={() => onOpenProject?.(d.project_id)}>
                              {d.name}
                            </button>
                            {" — "}{d.status}
                            {d.reason ? ` (${d.reason})` : ""}
                            {d.actions > 0 ? ` · ${d.actions} proposal(s)` : ""}
                            {d.next_step ? ` · next: ${typeof d.next_step === "object" ? d.next_step.text : d.next_step}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    {open && review && (
                      <div className="agents-run-detail">
                        {review.approved?.length > 0 && (
                          <>
                            <div className="agents-run-detail-h">Approved</div>
                            <ul>
                              {review.approved.map((a, i) => (
                                <li key={i}>
                                  <button className="agents-project-link" onClick={() => onOpenProject?.(a.project_id)}>
                                    {a.name}
                                  </button>
                                  {cert(a.certitude)}
                                  {a.redispatched ? <span className="agents-run-flag">redispatched</span> : null}
                                  {a.reason && <div className="agents-run-note">{a.reason}</div>}
                                  {a.outcome?.summary && (
                                    <div className="agents-run-note">outcome [{a.outcome.status}]: {a.outcome.summary}</div>
                                  )}
                                  {a.report_line && <div className="agents-run-note">QA: {a.report_line}</div>}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        {review.escalated?.length > 0 && (
                          <>
                            <div className="agents-run-detail-h">Escalated</div>
                            <ul>
                              {review.escalated.map((e, i) => (
                                <li key={i}>
                                  <button className="agents-project-link" onClick={() => onOpenProject?.(e.project_id)}>
                                    {e.name}
                                  </button>
                                  {cert(e.certitude)}
                                  <span className="agents-run-flag">{e.reason}</span>
                                  {e.wouldApprove ? <span className="agents-run-flag would">would approve</span> : null}
                                  {e.note && <div className="agents-run-note">{e.note}</div>}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {pickerOpen && (
        <AgentProjectPicker
          projects={projects}
          assignedIds={agent.projects.map((p) => p.id)}
          onAssign={assignProject}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {toast && <div className="modal-toast status-toast">{toast}</div>}
    </div>
  );
}
