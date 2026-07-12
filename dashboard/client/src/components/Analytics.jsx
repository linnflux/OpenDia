import { useState, useEffect, useCallback } from "react";

function fmtMin(min) {
  if (!min || min === 0) return "0m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function fmtWeekLabel(weekStart, weekEnd, weekKey) {
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  const s = new Date(weekStart + "T00:00:00Z").toLocaleDateString("en-US", opts);
  const e = new Date(weekEnd + "T00:00:00Z").toLocaleDateString("en-US", opts);
  return `Week of ${s} – ${e} (${weekKey})`;
}

function ageDays(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

export default function Analytics() {
  // Hours accordion state
  const [hoursOpen, setHoursOpen] = useState(true);
  const [week, setWeek] = useState(null); // null = current week
  const [weekData, setWeekData] = useState(null);
  const [loadingHours, setLoadingHours] = useState(false);
  const [errorHours, setErrorHours] = useState(null);
  const [expanded, setExpanded] = useState({}); // client → bool

  // Stale accordion state
  const [staleOpen, setStaleOpen] = useState(false);
  const [staleData, setStaleData] = useState(null);
  const [staleDays, setStaleDays] = useState(14);
  const [loadingStale, setLoadingStale] = useState(false);
  const [errorStale, setErrorStale] = useState(null);
  const [staleFetched, setStaleFetched] = useState(false);

  const fetchHours = useCallback(() => {
    setLoadingHours(true);
    setErrorHours(null);
    const params = week ? `?week=${week}` : "";
    fetch(`/api/analytics/week${params}`)
      .then((r) => r.json())
      .then((d) => { setWeekData(d); setLoadingHours(false); })
      .catch((e) => { setErrorHours(e.message); setLoadingHours(false); });
  }, [week]);

  const fetchStale = useCallback(() => {
    setLoadingStale(true);
    setErrorStale(null);
    fetch(`/api/analytics/stale?days=${staleDays}`)
      .then((r) => r.json())
      .then((d) => { setStaleData(d); setLoadingStale(false); setStaleFetched(true); })
      .catch((e) => { setErrorStale(e.message); setLoadingStale(false); });
  }, [staleDays]);

  useEffect(() => {
    if (hoursOpen) fetchHours();
  }, [fetchHours, hoursOpen]);

  useEffect(() => {
    if (staleOpen && !staleFetched) fetchStale();
  }, [staleOpen, staleFetched, fetchStale]);

  function toggleClient(client) {
    setExpanded((prev) => ({ ...prev, [client]: !prev[client] }));
  }

  function handleStaleOpen() {
    setStaleOpen((v) => !v);
  }

  function handleStaleDaysChange(e) {
    setStaleDays(parseInt(e.target.value, 10) || 14);
    setStaleFetched(false);
  }

  function handleStaleFetch() {
    fetchStale();
  }

  return (
    <div className="analytics-page">

      {/* Hours by Client × Week */}
      <div className="analytics-accordion-section">
        <button
          className={`analytics-accordion-header${hoursOpen ? " open" : ""}`}
          onClick={() => setHoursOpen((v) => !v)}
        >
          <span className="analytics-caret">{hoursOpen ? "▾" : "▸"}</span>
          Hours by Client × Week
        </button>

        {hoursOpen && (
          <div className="analytics-accordion-body">
            <div className="analytics-week-nav">
              <button
                className="analytics-week-btn"
                onClick={() => { setWeek(weekData?.prevWeek ?? null); setExpanded({}); }}
                disabled={loadingHours}
              >
                ◀
              </button>
              <span className="analytics-week-label">
                {weekData ? fmtWeekLabel(weekData.weekStart, weekData.weekEnd, weekData.week) : "Loading…"}
              </span>
              <button
                className="analytics-week-btn"
                onClick={() => { setWeek(weekData?.nextWeek ?? null); setExpanded({}); }}
                disabled={loadingHours}
              >
                ▶
              </button>
              <button
                className="analytics-week-btn analytics-today-btn"
                onClick={() => { setWeek(null); setExpanded({}); }}
                disabled={loadingHours || !week}
              >
                Today
              </button>
            </div>

            {loadingHours && <div className="analytics-loading">Loading…</div>}
            {errorHours && <div className="analytics-error">{errorHours}</div>}
            {!loadingHours && !errorHours && weekData && weekData.clients.length === 0 && (
              <div className="analytics-empty">No timer entries for this week.</div>
            )}
            {!loadingHours && !errorHours && weekData && weekData.clients.map((c) => (
              <div key={c.client} className="analytics-client-group">
                <button
                  className={`analytics-client-row${expanded[c.client] ? " open" : ""}`}
                  onClick={() => toggleClient(c.client)}
                >
                  <span className="analytics-caret">{expanded[c.client] ? "▾" : "▸"}</span>
                  <span className="analytics-client-name">{c.client}</span>
                  <span className="analytics-client-totals">
                    <span className="analytics-billable">{fmtMin(c.billable_min)}</span>
                    {c.nonbillable_min > 0 && (
                      <span className="analytics-nonbill"> + {fmtMin(c.nonbillable_min)} nb</span>
                    )}
                    <span className="analytics-total"> = {fmtMin(c.total_min)}</span>
                  </span>
                </button>
                {expanded[c.client] && (
                  <div className="analytics-entries">
                    {c.entries.map((e, i) => (
                      <div key={i} className="analytics-entry-row">
                        <span className="analytics-entry-date">{e.date}</span>
                        <span className="analytics-entry-task">{e.task || "—"}</span>
                        <span className="analytics-entry-est">{fmtMin(e.estimated_minutes)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stale in_progress cards */}
      <div className="analytics-accordion-section">
        <button
          className={`analytics-accordion-header${staleOpen ? " open" : ""}`}
          onClick={handleStaleOpen}
        >
          <span className="analytics-caret">{staleOpen ? "▾" : "▸"}</span>
          Stale in-progress cards
          <span className="analytics-stale-days-inline">
            {" "}(&gt;
            <input
              type="number"
              className="analytics-days-input"
              value={staleDays}
              min={1}
              max={365}
              onClick={(e) => e.stopPropagation()}
              onChange={handleStaleDaysChange}
            />
            days
            <button
              className="analytics-stale-go"
              onClick={(e) => { e.stopPropagation(); setStaleFetched(false); setTimeout(handleStaleFetch, 0); }}
            >
              Go
            </button>)
          </span>
        </button>

        {staleOpen && (
          <div className="analytics-accordion-body">
            {loadingStale && <div className="analytics-loading">Loading…</div>}
            {errorStale && <div className="analytics-error">{errorStale}</div>}
            {!loadingStale && !errorStale && staleData && staleData.length === 0 && (
              <div className="analytics-empty">No stale in-progress cards.</div>
            )}
            {!loadingStale && !errorStale && staleData && staleData.length > 0 && (
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
                  {staleData.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{s.company_name || "—"}</td>
                      <td>{s.division || "—"}</td>
                      <td className="analytics-num analytics-stale-age">
                        {ageDays(s.updated_at)}d ago
                      </td>
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

    </div>
  );
}
