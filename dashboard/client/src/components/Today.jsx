import { useState, useEffect, useMemo } from "react";

function fmtElapsed(seconds) {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ageDays(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

function fmtDue(due_start, due_end) {
  const s = due_end || due_start;
  if (!s) return "";
  try {
    const d = new Date(s);
    if (s.length === 10) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return s;
  }
}

export default function Today({ onOpenProject }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({
    deadlines: true,
    timers: true,
    wfhuman: true,
    stale: false,
    inbox: true,
    gmail: true,
  });
  const [deadlineSort, setDeadlineSort] = useState({ key: "due", dir: "asc" });
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  useEffect(() => {
    fetch("/api/today")
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  function toggle(key) {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function collapseAll() {
    setOpen({ deadlines: false, timers: false, wfhuman: false, stale: false, inbox: false, gmail: false });
  }
  function expandAll() {
    setOpen({ deadlines: true, timers: true, wfhuman: true, stale: true, inbox: true, gmail: true });
  }

  async function handleStatusChange(notionId, status) {
    setPendingIds((prev) => new Set(prev).add(notionId));
    try {
      const r = await fetch(`/api/deadlines/${notionId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(notionId);
        return next;
      });
      showToast(`Failed to set ${status}: ${e.message}`);
    }
  }

  async function handleBumpWeek(notionId) {
    try {
      const r = await fetch(`/api/deadlines/${notionId}/bump`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weeks: 1 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { due_start, due_end } = await r.json();
      setData((prev) => {
        if (!prev?.deadlines) return prev;
        const update = (arr) =>
          (arr || []).map((t) => (t.id === notionId ? { ...t, due_start, due_end } : t));
        return {
          ...prev,
          deadlines: {
            ...prev.deadlines,
            overdue: update(prev.deadlines.overdue),
            imminent: update(prev.deadlines.imminent),
            today: update(prev.deadlines.today),
          },
        };
      });
    } catch (e) {
      showToast(`Bump failed: ${e.message}`);
    }
  }

  async function refreshDeadlines() {
    setRefreshing(true);
    try {
      await fetch("/api/deadlines/refresh", { method: "POST" });
      const d = await fetch("/api/today").then((r) => r.json());
      setData(d);
      setPendingIds(new Set());
    } catch (e) {
      showToast(`Refresh failed: ${e.message}`);
    } finally {
      setRefreshing(false);
    }
  }

  function sortDeadlineBy(key) {
    setDeadlineSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  }

  const deadlineRows = useMemo(() => {
    const overdue = data?.deadlines?.overdue || [];
    const imminent = data?.deadlines?.imminent || [];
    const rows = [
      ...overdue.map((t) => ({ ...t, _overdue: true })),
      ...imminent.map((t) => ({ ...t, _overdue: false })),
    ].filter((t) => !pendingIds.has(t.id));
    const { key, dir } = deadlineSort;
    const mult = dir === "asc" ? 1 : -1;
    const getVal = (r) => {
      switch (key) {
        case "task": return (r.name || "").toLowerCase();
        case "client": return (r.company_name || r.company || "").toLowerCase();
        case "division": return (r.division || "").toLowerCase();
        case "notion": return r.id || "";
        case "due":
        default: return r.due_end || r.due_start || "";
      }
    };
    return rows.sort((a, b) => {
      const av = getVal(a), bv = getVal(b);
      if (av < bv) return -1 * mult;
      if (av > bv) return 1 * mult;
      return 0;
    });
  }, [data, deadlineSort, pendingIds]);

  if (loading) return <div className="analytics-loading">Loading…</div>;
  if (error) return <div className="analytics-error">{error}</div>;
  if (!data) return null;

  const { deadlines, wfhuman, stale, active_timers, inbox, gmail } = data;
  const overdueCount = deadlines.overdue?.length || 0;
  const imminentCount = deadlines.imminent?.length || 0;
  const totalDeadlines = overdueCount + imminentCount;

  return (
    <div className="analytics-page">

      <div className="today-toolbar">
        <button className="today-toolbar-btn" onClick={collapseAll}>Collapse all</button>
        <button className="today-toolbar-btn" onClick={expandAll}>Expand all</button>
      </div>

      {/* Deadlines */}
      <div className="analytics-accordion-section">
        <div className="analytics-accordion-header-row">
          <button
            className={`analytics-accordion-header${open.deadlines ? " open" : ""}`}
            onClick={() => toggle("deadlines")}
          >
            <span className="analytics-caret">{open.deadlines ? "▾" : "▸"}</span>
            Deadlines
            {overdueCount > 0 && (
              <span style={{ color: "#ef4444", marginLeft: 8, fontWeight: "bold" }}>
                {overdueCount} overdue
              </span>
            )}
            {imminentCount > 0 && (
              <span style={{ color: "#f59e0b", marginLeft: 8 }}>
                {imminentCount} soon
              </span>
            )}
            {totalDeadlines === 0 && !deadlines.error && (
              <span style={{ color: "#22c55e", marginLeft: 8, fontSize: "0.85em" }}>✓ clear</span>
            )}
            {deadlines.stale && (
              <span style={{ color: "#f59e0b", marginLeft: 8, fontSize: "0.78em" }}>(cache stale)</span>
            )}
          </button>
          <button
            className="deadline-refresh-btn"
            onClick={refreshDeadlines}
            disabled={refreshing}
            title="Re-fetch deadlines from Notion (~15s)"
          >{refreshing ? "…" : "↻"}</button>
        </div>
        {open.deadlines && (
          <div className="analytics-accordion-body">
            {deadlines.error && (
              <div className="analytics-error">Deadline cache: {deadlines.error}</div>
            )}
            {!deadlines.error && totalDeadlines === 0 && (
              <div className="analytics-empty">No upcoming deadlines.</div>
            )}
            {!deadlines.error && deadlineRows.length > 0 && (() => {
              const SortTh = ({ label, k }) => (
                <th onClick={() => sortDeadlineBy(k)} title={`Sort by ${label}`}>
                  {label}{deadlineSort.key === k && (deadlineSort.dir === "asc" ? " ▲" : " ▼")}
                </th>
              );
              return (
                <div className="table-scroll">
                <table className="analytics-table">
                  <thead>
                    <tr>
                      <SortTh label="Task" k="task" />
                      <SortTh label="Client" k="client" />
                      <SortTh label="Division" k="division" />
                      <SortTh label="Notion" k="notion" />
                      <SortTh label="Due" k="due" />
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deadlineRows.map((t) => (
                      <tr key={t.id} className={t._overdue ? "deadline-overdue-row" : ""}>
                        <td>{t.name}</td>
                        <td>{t.company_name || t.company || "—"}</td>
                        <td>{t.division || "—"}</td>
                        <td>
                          {t.id ? (
                            <a
                              href={`https://www.notion.so/${t.id.replace(/-/g, "")}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="Open in Notion"
                              className="deadline-notion-link"
                            >↗</a>
                          ) : "—"}
                        </td>
                        <td style={{ color: t._overdue ? "#ef4444" : undefined, whiteSpace: "nowrap" }}>
                          {fmtDue(t.due_start, t.due_end)}
                        </td>
                        <td className="deadline-actions-cell">
                          {t._overdue && t.id ? (
                            <>
                              <button
                                className="deadline-action-btn deadline-action-done"
                                title="Mark Completed in Notion"
                                onClick={() => handleStatusChange(t.id, "Completed")}
                              >✓ Done</button>
                              <button
                                className="deadline-action-btn deadline-action-ref"
                                title="Mark Reference in Notion"
                                onClick={() => handleStatusChange(t.id, "Reference")}
                              >Ref</button>
                              <button
                                className="deadline-action-btn deadline-action-bump"
                                title="Bump due date +1 week in Notion (clickable repeatedly)"
                                onClick={() => handleBumpWeek(t.id)}
                              >+1 wk</button>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Active timers */}
      <div className="analytics-accordion-section">
        <button
          className={`analytics-accordion-header${open.timers ? " open" : ""}`}
          onClick={() => toggle("timers")}
        >
          <span className="analytics-caret">{open.timers ? "▾" : "▸"}</span>
          Active Timers
          {active_timers.length > 0 ? (
            <span style={{ color: "#22c55e", marginLeft: 8 }}>● {active_timers.length} running</span>
          ) : (
            <span style={{ color: "#6b7280", marginLeft: 8, fontSize: "0.85em" }}>none</span>
          )}
        </button>
        {open.timers && (
          <div className="analytics-accordion-body">
            {active_timers.length === 0 ? (
              <div className="analytics-empty">No active timers.</div>
            ) : (
              <div className="table-scroll">
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Task</th>
                    <th>Division</th>
                    <th className="analytics-num">Elapsed</th>
                  </tr>
                </thead>
                <tbody>
                  {active_timers.map((t, i) => (
                    <tr key={i}>
                      <td>{t.client || "—"}</td>
                      <td>{t.task || t.project || "—"}</td>
                      <td>{t.division || "—"}</td>
                      <td className="analytics-num">{fmtElapsed(t.elapsed_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* WFHuman */}
      <div className="analytics-accordion-section">
        <button
          className={`analytics-accordion-header${open.wfhuman ? " open" : ""}`}
          onClick={() => toggle("wfhuman")}
        >
          <span className="analytics-caret">{open.wfhuman ? "▾" : "▸"}</span>
          Waiting for Human
          {wfhuman.count > 0 ? (
            <span style={{ color: "#f59e0b", marginLeft: 8 }}>{wfhuman.count}</span>
          ) : (
            <span style={{ color: "#22c55e", marginLeft: 8, fontSize: "0.85em" }}>✓ clear</span>
          )}
        </button>
        {open.wfhuman && (
          <div className="analytics-accordion-body">
            {wfhuman.items.length === 0 ? (
              <div className="analytics-empty">No WFHuman cards.</div>
            ) : (
              <div className="table-scroll">
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>Card</th>
                    <th>Client</th>
                    <th>Division</th>
                    <th className="analytics-num">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {wfhuman.items.map((p) => (
                    <tr
                      key={p.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => onOpenProject && onOpenProject(p.id)}
                    >
                      <td>{p.name}</td>
                      <td>{p.company_name || "—"}</td>
                      <td>{p.division || "—"}</td>
                      <td className="analytics-num analytics-stale-age">{ageDays(p.updated_at)}d ago</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Stale cards */}
      <div className="analytics-accordion-section">
        <button
          className={`analytics-accordion-header${open.stale ? " open" : ""}`}
          onClick={() => toggle("stale")}
        >
          <span className="analytics-caret">{open.stale ? "▾" : "▸"}</span>
          Stale In-Progress (&gt;14d)
          {stale.length > 0 ? (
            <span style={{ color: "#6b7280", marginLeft: 8 }}>{stale.length}</span>
          ) : (
            <span style={{ color: "#22c55e", marginLeft: 8, fontSize: "0.85em" }}>✓ clear</span>
          )}
        </button>
        {open.stale && (
          <div className="analytics-accordion-body">
            {stale.length === 0 ? (
              <div className="analytics-empty">No stale in-progress cards.</div>
            ) : (
              <div className="table-scroll">
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>Card</th>
                    <th>Client</th>
                    <th>Division</th>
                    <th className="analytics-num">Last update</th>
                    <th>Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {stale.map((s) => (
                    <tr
                      key={s.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => onOpenProject && onOpenProject(s.id)}
                    >
                      <td>{s.name}</td>
                      <td>{s.company_name || "—"}</td>
                      <td>{s.division || "—"}</td>
                      <td className="analytics-num analytics-stale-age">{ageDays(s.updated_at)}d ago</td>
                      <td className="analytics-next-step">{s.next_step || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Open inbox */}
      <div className="analytics-accordion-section">
        <button
          className={`analytics-accordion-header${open.inbox ? " open" : ""}`}
          onClick={() => toggle("inbox")}
        >
          <span className="analytics-caret">{open.inbox ? "▾" : "▸"}</span>
          Open Inbox
          {inbox.open_count > 0 ? (
            <span style={{ color: "#3b82f6", marginLeft: 8 }}>{inbox.open_count} open</span>
          ) : (
            <span style={{ color: "#22c55e", marginLeft: 8, fontSize: "0.85em" }}>✓ zero</span>
          )}
        </button>
        {open.inbox && (
          <div className="analytics-accordion-body">
            {inbox.open_count === 0 ? (
              <div className="analytics-empty">Inbox zero.</div>
            ) : (
              <>
                {inbox.recent.map((item) => (
                  <div key={item.id} className="analytics-entry-row">
                    <span className="analytics-entry-task">{item.subject || "(no subject)"}</span>
                    <span style={{ color: "#888", fontSize: "0.8em" }}>
                      {item.client_hint || item.project_name || ""}
                    </span>
                  </div>
                ))}
                {inbox.open_count > inbox.recent.length && (
                  <div style={{ color: "#888", fontSize: "0.8em", marginTop: 4 }}>
                    +{inbox.open_count - inbox.recent.length} more
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Gmail primary */}
      <div className="analytics-accordion-section">
        <button
          className={`analytics-accordion-header${open.gmail ? " open" : ""}`}
          onClick={() => toggle("gmail")}
        >
          <span className="analytics-caret">{open.gmail ? "▾" : "▸"}</span>
          Gmail Primary
        </button>
        {open.gmail && (
          <div className="analytics-accordion-body">
            {gmail.error ? (
              <div className="analytics-error">Gmail unavailable: {gmail.error}</div>
            ) : gmail.messages.length === 0 ? (
              <div className="analytics-empty">No messages.</div>
            ) : (
              gmail.messages.map((m) => (
                <div key={m.id} className="gmail-thread-row">
                  <a href={m.threadUrl} target="_blank" rel="noreferrer">
                    <div className="analytics-entry-task">{m.subject}</div>
                    <div style={{ color: "#888", fontSize: "0.8em" }}>{m.from}</div>
                    {m.snippet && (
                      <div style={{ color: "#666", fontSize: "0.75em", marginTop: 2 }}>
                        {m.snippet.slice(0, 240)}
                      </div>
                    )}
                  </a>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {toast && <div className="modal-toast">{toast}</div>}
    </div>
  );
}
