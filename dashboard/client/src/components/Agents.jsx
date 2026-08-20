import { useState, useEffect, useCallback } from "react";
import AgentDetail from "./AgentDetail.jsx";
import AgentAvatar from "./AgentAvatar.jsx";

// Queue timestamps arrive in two shapes: pending rows carry epoch ms
// (in-memory spark runs), processed rows carry the DB's naive-UTC
// "YYYY-MM-DD HH:MM:SS" strings. Both render as Eastern.
function fmtQueueTime(v) {
  if (v == null) return "";
  const d = typeof v === "number" ? new Date(v) : new Date(String(v).replace(" ", "T") + "Z");
  if (isNaN(d)) return "";
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const QUEUE_STATUS_LABEL = {
  awaiting: "awaiting review",
  escalated: "escalated — needs you",
  approved: "approved",
};

// The operator's end of the pipeline: what got done and what was escalated,
// as a dismissible inbox. Rows derive from the supervisor's verdict ledger;
// the ✓ acknowledges an item so the list only ever shows what the operator
// hasn't dealt with.
function OperatorInbox({ onOpenProject }) {
  const [items, setItems] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const fetchInbox = useCallback(() => {
    fetch("/api/agents/operator-inbox")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setItems(d.items || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchInbox();
    const t = setInterval(fetchInbox, 15000);
    return () => clearInterval(t);
  }, [fetchInbox]);

  async function ack(keys) {
    setItems((prev) => (prev || []).filter((i) => !keys.includes(i.key)));
    try {
      await fetch("/api/agents/operator-inbox/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      });
    } catch {
      fetchInbox();
    }
  }

  if (items === null) return null;
  const needs = items.filter((i) => i.kind === "escalated");
  const done = items.filter((i) => i.kind === "done");

  const row = (i) => {
    const open = expanded === i.key;
    return (
      <li key={i.key} className={`agents-queue-row status-${i.kind}`}>
        <div
          className="agents-queue-rowhead"
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(open ? null : i.key)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(open ? null : i.key); } }}
        >
          <span className="agents-queue-when">{fmtQueueTime(i.at)}</span>
          <button
            className="agents-queue-cardlink"
            onClick={(e) => { e.stopPropagation(); onOpenProject?.(i.project_id); }}
          >
            #{i.project_id} {i.name}
          </button>
          {i.certitude != null && <span className="agents-run-certitude">{i.certitude}%</span>}
          {i.kind === "done" && i.report_line && (
            <span className="agents-inbox-line">{i.report_line}</span>
          )}
          {i.kind === "escalated" && i.reason && (
            <span className="agents-inbox-line">{i.reason}</span>
          )}
          {i.shadow && <span className="agents-queue-status">shadow</span>}
          <button
            className="agents-inbox-ack"
            title="Dismiss — I've dealt with this"
            onClick={(e) => { e.stopPropagation(); ack([i.key]); }}
          >
            ✓
          </button>
        </div>
        {open && (
          <div className="agents-queue-detail">
            {i.note && <div className="agents-run-note">{i.note}</div>}
            {i.kind === "escalated" && i.wouldApprove && (
              <div className="agents-queue-meta">Carlos would have approved this on autopilot.</div>
            )}
            {i.kind === "done" && (
              <div className="agents-queue-meta">
                {[i.reason, i.outcome_summary, i.redispatched ? "redispatched once for a fix" : null]
                  .filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  const group = (label, cls, list) => (
    <>
      <div className={`agents-inbox-group ${cls}`}>
        {label} ({list.length})
        <button className="agents-queue-toggle agents-inbox-clear" onClick={() => ack(list.map((i) => i.key))}>
          Clear all
        </button>
      </div>
      <ul className="agents-queue-list">{list.map(row)}</ul>
    </>
  );

  return (
    <section className="agents-panel agents-queue agents-inbox">
      <div className="agents-queue-head">
        <h3 className="agents-queue-title">Operator inbox</h3>
        <span className="agents-queue-sub">
          {needs.length > 0 ? `${needs.length} need${needs.length === 1 ? "s" : ""} you` : "all caught up"}
          {done.length > 0 && ` · ${done.length} done`}
        </span>
      </div>
      {needs.length === 0 && done.length === 0 ? (
        <div className="agents-queue-empty">All clear — done and escalated items land here.</div>
      ) : (
        <>
          {needs.length > 0 && group("Needs your input", "esc", needs)}
          {done.length > 0 && group("Done", "ok", done)}
        </>
      )}
    </section>
  );
}

// The pile the scanners file for the supervisor. There is no queue table —
// an agent-filed spark run sitting in "proposing" IS the queue item, and the
// server overlays the supervisor's recent verdicts on top. Pending rows
// expand to the actual proposal; the processed tail holds recent verdicts.
function SupervisorQueue({ onOpenProject }) {
  const [q, setQ] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [showProcessed, setShowProcessed] = useState(false);

  const fetchQueue = useCallback(() => {
    fetch("/api/agents/review-queue")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setQ)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchQueue();
    const t = setInterval(fetchQueue, 15000);
    return () => clearInterval(t);
  }, [fetchQueue]);

  if (!q?.supervisor) return null;

  const rowHead = (key, open, children) => (
    <div
      className="agents-queue-rowhead"
      role="button"
      tabIndex={0}
      onClick={() => setExpanded(open ? null : key)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(open ? null : key); } }}
    >
      {children}
    </div>
  );

  const cardLink = (id, name) => (
    <button
      className="agents-queue-cardlink"
      onClick={(e) => { e.stopPropagation(); onOpenProject?.(id); }}
    >
      #{id} {name}
    </button>
  );

  return (
    <section className="agents-panel agents-queue">
      <div className="agents-queue-head">
        <h3 className="agents-queue-title">Supervisor queue</h3>
        <span className="agents-queue-sub">
          {q.supervisor.name} · {q.supervisor.autopilot ? "autopilot" : "shadow"} · {q.pending.length} pending
        </span>
      </div>

      {q.pending.length === 0 ? (
        <div className="agents-queue-empty">Nothing waiting — the scanners&rsquo; next filings land here.</div>
      ) : (
        <ul className="agents-queue-list">
          {q.pending.map((p) => {
            const key = `p:${p.spark_run_id}`;
            const open = expanded === key;
            return (
              <li key={key} className={`agents-queue-row status-${p.review_status}`}>
                {rowHead(key, open, (
                  <>
                    <span className="agents-queue-when">{fmtQueueTime(p.filed_at)}</span>
                    <span className="agents-queue-agent">{p.filed_by?.name || p.filed_by?.slug}</span>
                    {cardLink(p.project_id, p.project_name)}
                    {p.certitude?.pct != null && <span className="agents-run-certitude">{p.certitude.pct}%</span>}
                    {p.route && <span className={`agents-queue-route route-${p.route}`}>{p.route}</span>}
                    <span className={`agents-queue-status ${p.review_status}`}>{QUEUE_STATUS_LABEL[p.review_status]}</span>
                  </>
                ))}
                {open && (
                  <div className="agents-queue-detail">
                    <div className="agents-queue-step">{p.step.text}</div>
                    {p.step.why && <div className="agents-run-note">{p.step.why}</div>}
                    <div className="agents-queue-meta">
                      {[
                        p.step.estimated_minutes ? `${p.step.estimated_minutes}m` : null,
                        p.step.by_when ? `by ${p.step.by_when}` : null,
                        p.step.reversible != null ? (p.step.reversible ? "reversible" : "NOT reversible") : null,
                        p.certitude?.reason || null,
                      ].filter(Boolean).join(" · ")}
                    </div>
                    {p.step.first_action && (
                      <div className="agents-queue-meta">First action: {p.step.first_action}</div>
                    )}
                    {p.verdict && (
                      <div className="agents-run-note">
                        Verdict ({fmtQueueTime(p.verdict.at)}{p.verdict.shadow ? " · shadow" : ""}):{" "}
                        {p.verdict.reason || p.verdict.note || p.verdict.report_line || p.review_status}
                        {p.verdict.wouldApprove ? " — would approve on autopilot" : ""}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {q.processed.length > 0 && (
        <>
          <button className="agents-queue-toggle" onClick={() => setShowProcessed((v) => !v)}>
            {showProcessed ? "▾" : "▸"} Recently processed ({q.processed.length})
          </button>
          {showProcessed && (
            <ul className="agents-queue-list processed">
              {q.processed.map((e, i) => {
                const key = `d:${i}`;
                const open = expanded === key;
                return (
                  <li key={key} className={`agents-queue-row kind-${e.kind}`}>
                    {rowHead(key, open, (
                      <>
                        <span className="agents-queue-when">{fmtQueueTime(e.at)}</span>
                        {cardLink(e.project_id, e.name)}
                        {e.certitude != null && <span className="agents-run-certitude">{e.certitude}%</span>}
                        <span className={`agents-queue-status ${e.kind}`}>
                          {e.kind === "approved" ? "approved ✓" : "escalated ↗"}{e.shadow ? " · shadow" : ""}
                        </span>
                      </>
                    ))}
                    {open && (
                      <div className="agents-queue-detail">
                        {e.reason && <div className="agents-run-note">{e.reason}</div>}
                        {e.note && <div className="agents-run-note">{e.note}</div>}
                        {e.report_line && <div className="agents-queue-meta">{e.report_line}</div>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function dutySummary(d) {
  if (d.kind === "routine") {
    return `routine · every ${d.cadence_days || "∞"}d · card #${d.target_project_id ?? "?"}`;
  }
  return [
    d.roster_mode === "static" ? "assigned cards" : (d.query_status || "any status"),
    d.roster_mode !== "static" ? d.query_next_step : null,
    d.query_client_only ? "client-only" : null,
    d.triage ? "triage" : null,
    d.max_cards_per_heartbeat > 0 ? `${d.max_cards_per_heartbeat} card/hb` : "all cards",
  ].filter(Boolean).join(" · ");
}

// Duties: named, reusable scope-of-work units. The row is machine config,
// duty.md is the instructions; agents bind to duties and rotate through them
// one per heartbeat. This panel is where duties are created and edited.
function DutiesPanel({ agents, onOpenProject }) {
  const [duties, setDuties] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [fileDraft, setFileDraft] = useState(null); // {id, text}

  const fetchDuties = useCallback(() => {
    fetch("/api/duties")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDuties)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchDuties();
    const t = setInterval(fetchDuties, 15000);
    return () => clearInterval(t);
  }, [fetchDuties]);

  async function patchDuty(id, fields) {
    await fetch(`/api/duties/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }).catch(() => {});
    fetchDuties();
  }

  async function createNewDuty(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const r = await fetch("/api/duties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setCreating(false); setNewName("");
      fetchDuties();
      setExpanded(d.id);
    }
  }

  async function openFile(d) {
    const r = await fetch(`/api/duties/${d.id}/file`).catch(() => null);
    const j = r?.ok ? await r.json() : { duty_md: "" };
    setFileDraft({ id: d.id, text: j.duty_md || "" });
  }

  async function saveFile() {
    if (!fileDraft) return;
    await fetch(`/api/duties/${fileDraft.id}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duty_md: fileDraft.text }),
    }).catch(() => {});
    setFileDraft(null);
  }

  async function attach(dutyId, agentId) {
    if (!agentId) return;
    await fetch(`/api/agents/${agentId}/duties`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duty_id: dutyId }),
    }).catch(() => {});
    fetchDuties();
  }

  async function detach(dutyId, agentId) {
    await fetch(`/api/agents/${agentId}/duties/${dutyId}`, { method: "DELETE" }).catch(() => {});
    fetchDuties();
  }

  async function removeDuty(d) {
    if (!window.confirm(`Delete duty "${d.name}"? Its duty.md stays on disk; agents lose the binding.`)) return;
    await fetch(`/api/duties/${d.id}`, { method: "DELETE" }).catch(() => {});
    fetchDuties();
  }

  if (duties === null) return null;

  return (
    <section className="agents-panel agents-queue agents-duties">
      <div className="agents-queue-head">
        <h3 className="agents-queue-title">Duties</h3>
        <span className="agents-queue-sub">reusable scope-of-work, one per heartbeat in rotation</span>
        {creating ? (
          <form className="agents-create-form" onSubmit={createNewDuty}>
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Duty name" />
            <button type="submit">Create</button>
            <button type="button" onClick={() => { setCreating(false); setNewName(""); }}>Cancel</button>
          </form>
        ) : (
          <button className="agents-queue-toggle agents-duties-new" onClick={() => setCreating(true)}>+ New duty</button>
        )}
      </div>

      {duties.length === 0 ? (
        <div className="agents-queue-empty">No duties yet — agents run from their own roster settings until duties exist.</div>
      ) : (
        <ul className="agents-queue-list">
          {duties.map((d) => {
            const open = expanded === d.id;
            return (
              <li key={d.id} className="agents-queue-row">
                <div
                  className="agents-queue-rowhead"
                  role="button"
                  tabIndex={0}
                  onClick={() => { setExpanded(open ? null : d.id); setFileDraft(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(open ? null : d.id); } }}
                >
                  <span className="agents-queue-agent">{d.name}</span>
                  <span className="agents-queue-route">{d.kind}</span>
                  <span className="agents-inbox-line">{dutySummary(d)}</span>
                  <span className="agents-queue-status">
                    {d.agents.length ? d.agents.map((a) => a.name.replace(/ Agent$/, "")).join(", ") : "unattached"}
                  </span>
                </div>
                {open && (
                  <div className="agents-queue-detail agents-duties-detail">
                    <div className="agents-field">
                      <label>Kind</label>
                      <select value={d.kind} onChange={(e) => patchDuty(d.id, { kind: e.target.value })}>
                        <option value="sweep">sweep — work a card roster</option>
                        <option value="routine">routine — recurring procedure on one card</option>
                      </select>
                    </div>
                    {d.kind === "sweep" ? (
                      <>
                        <div className="agents-field">
                          <label>Roster</label>
                          <select value={d.roster_mode} onChange={(e) => patchDuty(d.id, { roster_mode: e.target.value })}>
                            <option value="query">query — recompute from the board</option>
                            <option value="static">static — the agent&rsquo;s assigned cards</option>
                          </select>
                        </div>
                        {d.roster_mode === "query" && (
                          <>
                            <div className="agents-field">
                              <label>Card statuses</label>
                              <div className="agents-day-chips">
                                {["in_progress", "wfhuman", "ice", "completed"].map((s) => {
                                  const cur = String(d.query_status || "").split(",").map((x) => x.trim()).filter(Boolean);
                                  const on = cur.includes(s);
                                  return (
                                    <button
                                      key={s}
                                      className={`agents-day-chip${on ? " on" : ""}`}
                                      onClick={() => patchDuty(d.id, { query_status: (on ? cur.filter((x) => x !== s) : [...cur, s]).join(",") })}
                                    >
                                      {s}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            <div className="agents-field">
                              <label>Next-step date filter</label>
                              <select value={d.query_next_step} onChange={(e) => patchDuty(d.id, { query_next_step: e.target.value })}>
                                <option value="any">any — no date filter</option>
                                <option value="stale">stale — overdue or undated</option>
                                <option value="due">due — dated, today or past</option>
                              </select>
                            </div>
                            <label className="switch">
                              <input type="checkbox" checked={!!d.triage} onChange={(e) => patchDuty(d.id, { triage: e.target.checked })} />
                              <span className="switch-track" />
                              Triage quick wins before scanning
                            </label>
                            <label className="switch">
                              <input type="checkbox" checked={!!d.query_client_only} onChange={(e) => patchDuty(d.id, { query_client_only: e.target.checked })} />
                              <span className="switch-track" />
                              Client deliverables only
                            </label>
                          </>
                        )}
                        <div className="agents-field">
                          <label>Cards / heartbeat (0 = all)</label>
                          <input
                            type="number" min="0"
                            defaultValue={d.max_cards_per_heartbeat}
                            onBlur={(e) => patchDuty(d.id, { max_cards_per_heartbeat: Number(e.target.value) || 0 })}
                            autoComplete="off" data-form-type="other"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="agents-field">
                          <label>Home card #</label>
                          <input
                            type="number" min="0"
                            defaultValue={d.target_project_id ?? ""}
                            onBlur={(e) => patchDuty(d.id, { target_project_id: Number(e.target.value) || 0 })}
                            autoComplete="off" data-form-type="other"
                          />
                          {d.target_project_id && (
                            <button className="agents-queue-toggle" onClick={() => onOpenProject?.(d.target_project_id)}>open card →</button>
                          )}
                        </div>
                        <div className="agents-field">
                          <label>Cadence (days between runs; 0 = every turn)</label>
                          <input
                            type="number" min="0"
                            defaultValue={d.cadence_days}
                            onBlur={(e) => patchDuty(d.id, { cadence_days: Number(e.target.value) || 0 })}
                            autoComplete="off" data-form-type="other"
                          />
                        </div>
                        {d.last_run_at && <div className="agents-queue-meta">Last run: {fmtQueueTime(d.last_run_at)}</div>}
                      </>
                    )}

                    <div className="agents-field">
                      <label>Attached agents</label>
                      <div className="agents-day-chips">
                        {d.agents.map((a) => (
                          <span key={a.id} className="agents-day-chip on">
                            {a.name.replace(/ Agent$/, "")}
                            <button className="agents-duties-detachx" title="Detach" onClick={() => detach(d.id, a.id)}>×</button>
                          </span>
                        ))}
                        <select value="" onChange={(e) => attach(d.id, e.target.value)}>
                          <option value="">+ attach…</option>
                          {(agents || [])
                            .filter((a) => a.role !== "supervisor" && !d.agents.some((x) => x.id === a.id))
                            .map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </div>
                    </div>

                    {fileDraft?.id === d.id ? (
                      <div className="agents-field agents-duties-file">
                        <label>duty.md</label>
                        <textarea
                          rows={16}
                          value={fileDraft.text}
                          onChange={(e) => setFileDraft({ id: d.id, text: e.target.value })}
                        />
                        <div>
                          <button onClick={saveFile}>Save</button>
                          <button onClick={() => setFileDraft(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button className="agents-queue-toggle" onClick={() => openFile(d)}>▸ Edit instructions (duty.md)</button>
                    )}

                    <button className="agents-queue-toggle agents-duties-delete" onClick={() => removeDuty(d)}>Delete duty</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

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

      <OperatorInbox onOpenProject={onOpenProject} />
      <SupervisorQueue onOpenProject={onOpenProject} />
      <DutiesPanel agents={agents} onOpenProject={onOpenProject} />
    </div>
  );
}
