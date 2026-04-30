import { useState, useEffect, useCallback } from "react";

function fmtMin(min) {
  if (!min || min === 0) return "0m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 56); // 8 weeks
  return d.toISOString().slice(0, 10);
}

function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}

function ageDays(isoDate) {
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.floor(ms / 86400000);
}

export default function Analytics() {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [staleDays, setStaleDays] = useState(14);

  const [hours, setHours] = useState(null);
  const [variance, setVariance] = useState(null);
  const [stale, setStale] = useState(null);
  const [loadingHours, setLoadingHours] = useState(true);
  const [loadingVariance, setLoadingVariance] = useState(true);
  const [loadingStale, setLoadingStale] = useState(true);
  const [errorHours, setErrorHours] = useState(null);
  const [errorVariance, setErrorVariance] = useState(null);
  const [errorStale, setErrorStale] = useState(null);

  const fetchAll = useCallback(() => {
    const params = new URLSearchParams({ from, to });

    setLoadingHours(true);
    setErrorHours(null);
    fetch(`/api/analytics/hours-by-client?${params}`)
      .then((r) => r.json())
      .then((d) => { setHours(d); setLoadingHours(false); })
      .catch((e) => { setErrorHours(e.message); setLoadingHours(false); });

    setLoadingVariance(true);
    setErrorVariance(null);
    fetch(`/api/analytics/estimate-variance?${params}`)
      .then((r) => r.json())
      .then((d) => { setVariance(d); setLoadingVariance(false); })
      .catch((e) => { setErrorVariance(e.message); setLoadingVariance(false); });

    setLoadingStale(true);
    setErrorStale(null);
    fetch(`/api/analytics/stale?days=${staleDays}`)
      .then((r) => r.json())
      .then((d) => { setStale(d); setLoadingStale(false); })
      .catch((e) => { setErrorStale(e.message); setLoadingStale(false); });
  }, [from, to, staleDays]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Flatten hours data into rows for the table
  const hoursRows = hours
    ? hours.flatMap((c) =>
        c.weeks.map((w) => ({
          client: c.client,
          week: w.week,
          billable_min: w.billable_min,
          nonbillable_min: w.nonbillable_min,
          total_min: w.billable_min + w.nonbillable_min,
          entries: w.entries,
        }))
      )
    : [];

  return (
    <div className="analytics-page">
      <div className="analytics-controls">
        <label className="analytics-label">
          From
          <input
            type="date"
            className="analytics-date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="analytics-label">
          To
          <input
            type="date"
            className="analytics-date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="analytics-refresh-btn" onClick={fetchAll}>
          Refresh
        </button>
      </div>

      {/* Hours by Client × Week */}
      <section className="analytics-section">
        <h2 className="analytics-heading">Hours by Client × Week</h2>
        {loadingHours && <div className="analytics-loading">Loading…</div>}
        {errorHours && <div className="analytics-error">{errorHours}</div>}
        {!loadingHours && !errorHours && hoursRows.length === 0 && (
          <div className="analytics-empty">No completed timer entries in this range.</div>
        )}
        {!loadingHours && !errorHours && hoursRows.length > 0 && (
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Week</th>
                <th className="analytics-num">Billable</th>
                <th className="analytics-num">Non-bill</th>
                <th className="analytics-num">Total</th>
                <th className="analytics-num">Entries</th>
              </tr>
            </thead>
            <tbody>
              {hoursRows.map((r, i) => (
                <tr key={i}>
                  <td>{r.client}</td>
                  <td className="analytics-mono">{r.week}</td>
                  <td className="analytics-num analytics-billable">{fmtMin(r.billable_min)}</td>
                  <td className="analytics-num analytics-nonbill">{fmtMin(r.nonbillable_min)}</td>
                  <td className="analytics-num analytics-bold">{fmtMin(r.total_min)}</td>
                  <td className="analytics-num">{r.entries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Estimate vs Actual */}
      <section className="analytics-section">
        <h2 className="analytics-heading">Estimate vs Actual (top variances)</h2>
        {loadingVariance && <div className="analytics-loading">Loading…</div>}
        {errorVariance && <div className="analytics-error">{errorVariance}</div>}
        {!loadingVariance && !errorVariance && (!variance || variance.length === 0) && (
          <div className="analytics-empty">No entries with estimates in this range.</div>
        )}
        {!loadingVariance && !errorVariance && variance && variance.length > 0 && (
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Project / Task</th>
                <th className="analytics-num">Est</th>
                <th className="analytics-num">Actual</th>
                <th className="analytics-num">Δ</th>
                <th className="analytics-num">%</th>
                <th className="analytics-num">Entries</th>
              </tr>
            </thead>
            <tbody>
              {variance.map((v, i) => {
                const over = v.variance_min > 0;
                const under = v.variance_min < 0;
                return (
                  <tr key={i}>
                    <td>{v.client}</td>
                    <td>{v.project}</td>
                    <td className="analytics-num">{fmtMin(v.estimated_min)}</td>
                    <td className="analytics-num">{fmtMin(v.actual_min)}</td>
                    <td className={`analytics-num ${over ? "analytics-over" : under ? "analytics-under" : ""}`}>
                      {v.variance_min > 0 ? "+" : ""}{fmtMin(Math.abs(v.variance_min))}
                      {v.variance_min < 0 ? " under" : v.variance_min > 0 ? " over" : ""}
                    </td>
                    <td className={`analytics-num ${over ? "analytics-over" : under ? "analytics-under" : ""}`}>
                      {v.variance_pct !== null ? `${v.variance_pct > 0 ? "+" : ""}${v.variance_pct}%` : "—"}
                    </td>
                    <td className="analytics-num">{v.entries}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Stale in_progress cards */}
      <section className="analytics-section">
        <h2 className="analytics-heading">
          Stale in-progress cards
          <label className="analytics-stale-days">
            (&gt;
            <input
              type="number"
              className="analytics-days-input"
              value={staleDays}
              min={1}
              max={365}
              onChange={(e) => setStaleDays(parseInt(e.target.value, 10) || 14)}
            />
            days)
          </label>
        </h2>
        {loadingStale && <div className="analytics-loading">Loading…</div>}
        {errorStale && <div className="analytics-error">{errorStale}</div>}
        {!loadingStale && !errorStale && (!stale || stale.length === 0) && (
          <div className="analytics-empty">No stale in-progress cards.</div>
        )}
        {!loadingStale && !errorStale && stale && stale.length > 0 && (
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
        )}
      </section>
    </div>
  );
}
