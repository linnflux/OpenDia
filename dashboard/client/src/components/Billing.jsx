import { useState, useCallback } from "react";

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1VowYnKQG3lM-RZIVqgtlCHc2QSx364epvdiRlSMsLFY";

function fmtMin(min) {
  if (!min || min === 0) return "0m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function lastMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function Billing() {
  const [month, setMonth] = useState(lastMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});

  const fetchPreview = useCallback(() => {
    setLoading(true);
    setError(null);
    setExpanded({});
    fetch(`/api/billing/preview?month=${month}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [month]);

  function toggleClient(client) {
    setExpanded((prev) => ({ ...prev, [client]: !prev[client] }));
  }

  const grandTotal = data ? data.clients.reduce((s, c) => s + c.total_min, 0) : 0;
  const billableTotal = data ? data.clients.reduce((s, c) => s + c.billable_min, 0) : 0;

  return (
    <div className="billing-page">
      <div className="billing-controls">
        <label className="billing-label">
          Month
          <input
            type="month"
            className="billing-month-input"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <button className="billing-generate-btn" onClick={fetchPreview} disabled={loading}>
          {loading ? "Loading…" : "Generate Preview"}
        </button>
        <a
          href={SHEET_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="billing-sheet-link"
        >
          Open Billing Master ↗
        </a>
      </div>

      {error && <div className="billing-error">{error}</div>}

      {data && (
        <>
          <div className="billing-summary-bar">
            <span className="billing-summary-month">{data.month}</span>
            <span className="billing-summary-total">
              <span className="billing-summary-billable">{fmtMin(billableTotal)} billable</span>
              {" / "}
              <span className="billing-summary-grand">{fmtMin(grandTotal)} total</span>
            </span>
          </div>

          <div className="billing-clients">
            {data.clients.map((c) => (
              <div key={c.client} className="billing-client-group">
                <button
                  className={`billing-client-row${expanded[c.client] ? " open" : ""}`}
                  onClick={() => toggleClient(c.client)}
                >
                  <span className="billing-caret">{expanded[c.client] ? "▾" : "▸"}</span>
                  <span className="billing-client-name">{c.client}</span>
                  <span className="billing-client-totals">
                    {c.billable_min > 0 && (
                      <span className="billing-billable">{fmtMin(c.billable_min)}</span>
                    )}
                    {c.nonbillable_min > 0 && (
                      <span className="billing-nonbill"> +{fmtMin(c.nonbillable_min)} nb</span>
                    )}
                  </span>
                </button>
                {expanded[c.client] && (
                  <div className="billing-entries">
                    {c.entries.map((e, i) => (
                      <div key={i} className="billing-entry-row">
                        <span className="billing-entry-date">{e.date}</span>
                        <span className="billing-entry-div">{e.division}</span>
                        <span className="billing-entry-task">{e.task}</span>
                        <span className="billing-entry-est">{fmtMin(e.estimated_minutes)}</span>
                        {!e.billable && <span className="billing-entry-nb">nb</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="billing-push-row">
            <button className="billing-push-btn" disabled title="Push-to-sheet coming soon">
              Push to Billing Master
            </button>
            <span className="billing-push-note">Not yet wired — use <code>/monthly-billing</code> in the terminal</span>
          </div>
        </>
      )}
    </div>
  );
}
