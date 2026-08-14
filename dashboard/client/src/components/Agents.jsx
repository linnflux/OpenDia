import { useState, useEffect, useCallback } from "react";
import AgentDetail from "./AgentDetail.jsx";

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
    if (a.active) return { cls: "working", label: a.current_project ? `working: ${a.current_project.name}` : "working" };
    if (a.in_window) return { cls: "idle", label: "idle (in window)" };
    return { cls: "off", label: "off-schedule" };
  }

  function scheduleStr(a) {
    const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = String(a.schedule_days || "").split(",").map((d) => DAY[Number(d)]).filter(Boolean);
    const dayStr = days.length === 5 && days[0] === "Mon" && days[4] === "Fri"
      ? "Mon–Fri" : days.join(" ");
    return `${dayStr} ${a.schedule_start}–${a.schedule_end} ET · every ${a.heartbeat_minutes}m`;
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
        <table className="agents-table">
          <thead>
            <tr>
              <th></th><th>Name</th><th>Schedule</th><th>Cards</th>
              <th>Pending</th><th>Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const dot = statusDot(a);
              return (
                <tr key={a.id} className="agents-row" onClick={() => setSelectedId(a.id)}>
                  <td><span className={`agents-dot ${dot.cls}`} title={dot.label} /></td>
                  <td className="agents-name">
                    {a.name}
                    {a.active && a.current_project && (
                      <span className="agents-current">→ {a.current_project.name}</span>
                    )}
                  </td>
                  <td className="agents-schedule">{scheduleStr(a)}</td>
                  <td className="agents-count">{a.project_count}</td>
                  <td className="agents-count">
                    {a.pending_approvals > 0 ? (
                      <span className="agents-pending">{a.pending_approvals}</span>
                    ) : "—"}
                  </td>
                  <td className="agents-lastrun">
                    {a.last_run
                      ? `${a.last_run.status} · ${a.last_run.tokens_used?.toLocaleString() ?? 0} tok · $${(a.last_run.cost_usd || 0).toFixed(2)}`
                      : "never"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
