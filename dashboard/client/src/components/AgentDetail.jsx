import { useState, useEffect, useCallback, useRef } from "react";
import AgentProjectPicker from "./AgentProjectPicker.jsx";

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

  return (
    <div className="agents-view agents-detail">
      <div className="agents-detail-header">
        <button className="agents-back" onClick={onBack}>← All agents</button>
        <h2 className="agents-title">
          {agent.name}
          <span className={`agents-dot ${agent.active ? "working" : agent.enabled ? (agent.in_window ? "idle" : "off") : "disabled"}`} />
        </h2>
        <div className="agents-detail-actions">
          <button onClick={runNow} disabled={agent.active}>Run now</button>
          <button onClick={requestStatus}>Request status</button>
          <label className="agents-enable-toggle">
            <input
              type="checkbox"
              checked={!!agent.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enabled
          </label>
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
        <section className="agents-panel">
          <h3>Settings</h3>
          <div className="agents-field">
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
          <div className="agents-field-row">
            <div className="agents-field">
              <label>Start (ET)</label>
              <input
                type="time"
                defaultValue={agent.schedule_start}
                onBlur={(e) => e.target.value !== agent.schedule_start && patch({ schedule_start: e.target.value })}
              />
            </div>
            <div className="agents-field">
              <label>End (ET)</label>
              <input
                type="time"
                defaultValue={agent.schedule_end}
                onBlur={(e) => e.target.value !== agent.schedule_end && patch({ schedule_end: e.target.value })}
              />
            </div>
            <div className="agents-field">
              <label>Heartbeat (min)</label>
              <input
                type="number" min="5" step="5"
                defaultValue={agent.heartbeat_minutes}
                onBlur={(e) => Number(e.target.value) !== agent.heartbeat_minutes && patch({ heartbeat_minutes: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="agents-field-row">
            <div className="agents-field">
              <label>Token limit / heartbeat</label>
              <input
                type="number" min="1000" step="1000"
                defaultValue={agent.heartbeat_token_limit}
                onBlur={(e) => Number(e.target.value) !== agent.heartbeat_token_limit && patch({ heartbeat_token_limit: Number(e.target.value) })}
              />
            </div>
            <div className="agents-field">
              <label>Budget / card (USD)</label>
              <input
                type="number" min="0.25" step="0.25"
                defaultValue={agent.run_budget_usd}
                onBlur={(e) => Number(e.target.value) !== agent.run_budget_usd && patch({ run_budget_usd: Number(e.target.value) })}
              />
            </div>
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
          {isSupervisor && (
            <div className="agents-field-row">
              <div className="agents-field">
                <label>Min certitude to approve</label>
                <input
                  type="number" min="0" max="100" step="5"
                  defaultValue={agent.min_certitude}
                  onBlur={(e) => Number(e.target.value) !== agent.min_certitude && patch({ min_certitude: Number(e.target.value) })}
                />
              </div>
              <div className="agents-field">
                <label>Max auto-approvals / pass</label>
                <input
                  type="number" min="0" step="1"
                  defaultValue={agent.max_auto_approvals}
                  onBlur={(e) => Number(e.target.value) !== agent.max_auto_approvals && patch({ max_auto_approvals: Number(e.target.value) })}
                />
              </div>
              <div className="agents-field">
                <label>Mode</label>
                <label className="agents-enable-toggle" title="Shadow reviews and escalates only, recording what it would have approved.">
                  <input
                    type="checkbox"
                    checked={!!agent.autopilot}
                    onChange={(e) => patch({ autopilot: e.target.checked })}
                  />
                  {agent.autopilot ? "Autopilot — approve within guardrails" : "Shadow — review & escalate only"}
                </label>
              </div>
            </div>
          )}
          <div className="agents-field-row">
            <div className="agents-field">
              <label>Chat notifications</label>
              <select value={agent.chat_mode} onChange={(e) => patch({ chat_mode: e.target.value })}>
                <option value="per_heartbeat">per heartbeat</option>
                <option value="quiet">quiet</option>
                <option value="digest">window digest</option>
              </select>
            </div>
            <div className="agents-field">
              <label>Max cards / heartbeat (0 = all)</label>
              <input
                type="number" min="0" step="1"
                defaultValue={agent.max_cards_per_heartbeat}
                onBlur={(e) => Number(e.target.value) !== agent.max_cards_per_heartbeat && patch({ max_cards_per_heartbeat: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="agents-field">
            <label>Chat webhook URL (blank = global)</label>
            <input
              type="text"
              defaultValue={agent.chat_webhook_url || ""}
              placeholder="https://chat.googleapis.com/v1/spaces/…"
              onBlur={(e) => (e.target.value || null) !== agent.chat_webhook_url && patch({ chat_webhook_url: e.target.value || null })}
            />
          </div>
        </section>

        {!isSupervisor && (
        <section className="agents-panel">
          <h3>
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
              <label className="agents-enable-toggle">
                <input
                  type="checkbox"
                  checked={agent.query_next_step === "stale"}
                  onChange={(e) => patch({ query_next_step: e.target.checked ? "stale" : "any" })}
                />
                Only cards with an overdue or missing next-step date
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
        </section>
        )}

        {["agent_md", "memory_md"].map((fileKey) => (
          <section className="agents-panel" key={fileKey}>
            <h3>
              {fileKey === "agent_md" ? "Persona & expertise (agent.md)" : `Memory (memory.md · ${agent.memory_lines} lines)`}
              {fileKey === "memory_md" && memoryWarn && (
                <span className="agents-memory-warn">over 80 lines — needs pruning</span>
              )}
              {editingFile === fileKey ? (
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
              )}
            </h3>
            {editingFile === fileKey ? (
              <textarea
                className="agents-file-editor"
                value={fileDraft}
                onChange={(e) => setFileDraft(e.target.value)}
                rows={14}
              />
            ) : (
              <pre className="agents-file-view">{agent[fileKey] || "(empty)"}</pre>
            )}
          </section>
        ))}

        <section className="agents-panel agents-feed">
          <h3>Activity</h3>
          {agent.runs.length === 0 ? (
            <div className="agents-empty">No heartbeats yet.</div>
          ) : (
            <ul className="agents-run-list">
              {agent.runs.map((r) => {
                let detail = [];
                try { detail = JSON.parse(r.detail || "[]"); } catch {}
                const open = expandedRun === r.id;
                return (
                  <li key={r.id} className={`agents-run status-${r.status}`}>
                    <button className="agents-run-head" onClick={() => setExpandedRun(open ? null : r.id)}>
                      <span className={`agents-run-status ${r.status}`}>{r.status}</span>
                      <span className="agents-run-when">{fmtET(r.started_at)}</span>
                      <span className="agents-run-summary">{r.summary || r.trigger}</span>
                      {r.tokens_used > 0 && (
                        <span className="agents-run-cost">{r.tokens_used.toLocaleString()} tok · ${(r.cost_usd || 0).toFixed(2)}</span>
                      )}
                    </button>
                    {open && detail.length > 0 && (
                      <ul className="agents-run-detail">
                        {detail.map((d, i) => (
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
