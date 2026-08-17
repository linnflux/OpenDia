import { useState, useEffect, useCallback } from "react";
import AgentDetail from "./AgentDetail.jsx";
import AgentAvatar from "./AgentAvatar.jsx";

// Admin roster of OpenDia Agents (ODAs). List view polls like Rooms; clicking
// a row opens the detail view, which owns its own fetching and live stream.
export default function Agents({ projects, onOpenProject }) {
  const [agents, setAgents] = useState(null);   // null = loading
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const fetchAgents = useCallback(() => {
    fetch("/api/agents")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => { setAgents(data); setError(null); })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    fetchAgents();
    const t = setInterval(fetchAgents, 15000);
    return () => clearInterval(t);
  }, [fetchAgents]);

  async function createAgent(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const r = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      const agent = await r.json();
      setCreating(false);
      setNewName("");
      fetchAgents();
      setSelectedId(agent.id);
    } catch (err) {
      setError(err.message);
    }
  }

  function statusDot(a) {
    if (!a.enabled) return { cls: "disabled", label: "disabled" };
    if (a.active) return { cls: "working", label: a.current_project ? `working — ${a.current_project.name}` : "working" };
    if (a.in_window) return { cls: "idle", label: "idle — in window" };
    return { cls: "off", label: `next window ${a.schedule_start} ET` };
  }

  // Optimistic flip so the switch answers instantly; the 15s poll (or the
  // refetch on failure) reconciles with the server's truth.
  async function toggleEnabled(agent, value) {
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled: value ? 1 : 0 } : a)));
    try {
      const r = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: value }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      fetchAgents();
    }
  }

  function scheduleStr(a) {
    const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = String(a.schedule_days || "").split(",").map((d) => DAY[Number(d)]).filter(Boolean);
    const dayStr = days.length === 5 && days[0] === "Mon" && days[4] === "Fri"
      ? "Mon–Fri" : days.join(" ");
    const cap = a.max_cards_per_heartbeat > 0 ? ` · ${a.max_cards_per_heartbeat} card/hb` : "";
    return `${dayStr} ${a.schedule_start}–${a.schedule_end} ET · every ${a.heartbeat_minutes}m${cap}`;
  }

  if (selectedId) {
    return (
      <AgentDetail
        agentId={selectedId}
        projects={projects}
        onOpenProject={onOpenProject}
        onBack={() => { setSelectedId(null); fetchAgents(); }}
      />
    );
  }

  if (error) {
    return <div className="agents-view"><div className="agents-error">Agents API error: {error}</div></div>;
  }
  if (agents === null) return <div className="loading">Loading agents...</div>;

  return (
    <div className="agents-view">
      <div className="agents-header">
        <h2 className="agents-title">OpenDia Agents</h2>
        {creating ? (
          <form className="agents-create-form" onSubmit={createAgent}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Agent name (e.g. Carlos F Agent)"
            />
            <button type="submit">Create</button>
            <button type="button" onClick={() => { setCreating(false); setNewName(""); }}>Cancel</button>
          </form>
        ) : (
          <button className="agents-new-btn" onClick={() => setCreating(true)}>+ New agent</button>
        )}
      </div>

      {agents.length === 0 ? (
        <div className="agents-empty">No agents yet. Create one to get started.</div>
      ) : (
        <div className="agents-grid">
          {agents.map((a) => {
            const dot = statusDot(a);
            return (
              <div
                key={a.id}
                className="card agent-card"
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(a.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(a.id); } }}
              >
                <label
                  className="switch agent-card-switch"
                  title={a.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={!!a.enabled}
                    onChange={(e) => toggleEnabled(a, e.target.checked)}
                  />
                  <span className="switch-track" />
                </label>

                <div className="agent-card-top">
                  <AgentAvatar slug={a.slug} name={a.name} size="card" />
                  <div className="agent-card-title">
                    <div className="card-name">{a.name}</div>
                    {a.role === "supervisor" && <span className="agents-role-badge">supervisor</span>}
                  </div>
                </div>

                <div className="agent-card-status">
                  <span className={`agents-dot ${dot.cls}`} />
                  <span>{dot.label}</span>
                </div>

                <div className="agent-card-meta">
                  <span>{scheduleStr(a)}</span>
                  <span className="agent-card-lastrun">
                    {a.last_run
                      ? `${a.last_run.status} · ${(a.last_run.tokens_used ?? 0).toLocaleString()} tok · $${(a.last_run.cost_usd || 0).toFixed(2)}`
                      : "no runs yet"}
                  </span>
                  {a.pending_approvals > 0 && (
                    <span className="agent-card-pending">{a.pending_approvals} awaiting decision</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
