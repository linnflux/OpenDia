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

function fmtHours(h) {
  if (!h || h === 0) return "0";
  return h % 1 === 0 ? `${h}` : h.toFixed(2).replace(/\.?0+$/, "");
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
  const [savingStart, setSavingStart] = useState(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState(null);

  const fetchPreview = useCallback(() => {
    setLoading(true);
    setError(null);
    setExpanded({});
    setPushResult(null);
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

  function toggleBillable(entry, clientName) {
    if (!entry.start || savingStart) return;
    const newBillable = !entry.billable;
    setSavingStart(entry.start);
    // Optimistic update
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        clients: prev.clients.map((c) => {
          if (c.client !== clientName) return c;
          let billable_min = c.billable_min;
          let nonbillable_min = c.nonbillable_min;
          const delta = entry.estimated_minutes;
          if (newBillable) { billable_min += delta; nonbillable_min -= delta; }
          else { billable_min -= delta; nonbillable_min += delta; }
          return {
            ...c,
            billable_min,
            nonbillable_min,
            entries: c.entries.map((e) =>
              e.start === entry.start ? { ...e, billable: newBillable } : e
            ),
          };
        }),
      };
    });
    fetch("/api/billing/entry", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: entry.start, billable: newBillable }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
      })
      .catch((e) => {
        setError(`Toggle failed: ${e.message}`);
        fetchPreview();
      })
      .finally(() => setSavingStart(null));
  }

  function pushToSheet() {
    setPushing(true);
    setError(null);
    fetch("/api/billing/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setPushResult(d);
      })
      .catch((e) => setError(`Push failed: ${e.message}`))
      .finally(() => {
        setPushing(false);
        setConfirmPush(false);
      });
  }

  const grandTotalMin = data ? data.grand_total_min ?? data.clients.reduce((s, c) => s + c.total_min, 0) : 0;
  const grandTotalHours = data ? data.grand_total_hours ?? 0 : 0;
  const grandBillableHours = data ? data.grand_billable_hours ?? 0 : 0;
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

      {pushResult && (
        <div className="billing-push-result">
          ✓ Pushed {pushResult.rows ?? "?"} rows for {pushResult.month}.
          {" "}
          <a href={pushResult.sheet_url} target="_blank" rel="noopener noreferrer">
            View OpenDia tab ↗
          </a>
        </div>
      )}

      {data && (
        <>
          <div className="billing-summary-bar">
            <span className="billing-summary-month">{data.month}</span>
            <span className="billing-summary-total">
              <span className="billing-summary-billable">{fmtMin(billableTotal)} billable</span>
              {" / "}
              <span className="billing-summary-grand">{fmtMin(grandTotalMin)} total</span>
              <span className="billing-summary-hours"> · {fmtHours(grandBillableHours)} hrs (sheet) · {fmtHours(grandTotalHours)} all hrs</span>
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
                    <span className="billing-client-hours">
                      {" · "}{fmtHours(c.billable_hours ?? c.total_hours)} hrs
                    </span>
                  </span>
                </button>
                {expanded[c.client] && (
                  <div className="billing-entries">
                    {c.entries.map((e) => {
                      const saving = savingStart === e.start;
                      return (
                        <div key={e.start || `${e.date}-${e.task}`} className="billing-entry-row">
                          <span className="billing-entry-date">{e.date}</span>
                          <span className="billing-entry-div">{e.division}</span>
                          <span className="billing-entry-task">{e.task}</span>
                          <span className="billing-entry-est">{fmtMin(e.estimated_minutes)}</span>
                          <button
                            type="button"
                            className={`billing-entry-billable-btn${e.billable ? " is-billable" : " is-nonbill"}${saving ? " saving" : ""}`}
                            onClick={() => toggleBillable(e, c.client)}
                            disabled={saving || !e.start}
                            title={e.start ? `Click to mark ${e.billable ? "non-billable" : "billable"}` : "No start marker — cannot toggle"}
                          >
                            $
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="billing-push-row">
            <button
              className="billing-push-btn"
              onClick={() => setConfirmPush(true)}
              disabled={pushing}
            >
              {pushing ? "Pushing…" : "Push to Billing Master"}
            </button>
            <span className="billing-push-note">
              Overwrites the OpenDia tab for {month} — re-pushable, idempotent.
            </span>
          </div>
        </>
      )}

      {confirmPush && (
        <div className="billing-confirm-backdrop" onClick={() => !pushing && setConfirmPush(false)}>
          <div className="billing-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Push {month} to Billing Master?</h3>
            <p>
              This will <strong>clear and overwrite</strong> the OpenDia tab in the Billing Master sheet.
              The detail rows and subtotals will be regenerated from the timer files for {month}.
            </p>
            <p className="billing-confirm-meta">
              {data?.clients.length ?? 0} clients · {fmtMin(grandTotalMin)} total · {fmtHours(grandBillableHours)} billable hrs
            </p>
            <div className="billing-confirm-actions">
              <button
                className="billing-confirm-cancel"
                onClick={() => setConfirmPush(false)}
                disabled={pushing}
              >
                Cancel
              </button>
              <button
                className="billing-confirm-push"
                onClick={pushToSheet}
                disabled={pushing}
              >
                {pushing ? "Pushing…" : "Push to Sheet"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
