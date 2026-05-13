import { useEffect, useRef, useState, useMemo } from "react";
import useCompaniesList from "../hooks/useCompaniesList.js";

function ClientAutocomplete({ value, onChange, companies }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const matches = useMemo(() => {
    if (!value || !companies?.length) return [];
    const q = value.toLowerCase();
    const scored = [];
    for (const c of companies) {
      let score = 0;
      if ((c.short_name || "").toLowerCase().includes(q)) score += 3;
      if ((c.name || "").toLowerCase().includes(q)) score += 2;
      if (score > 0) scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, 8).map((s) => s.c);
    // Hide if the current value is already an exact match
    if (results.length === 1 && results[0].name.toLowerCase() === q) return [];
    return results;
  }, [value, companies]);

  const showList = open && matches.length > 0;

  function select(name) {
    onChange(name);
    setOpen(false);
    setActiveIdx(0);
  }

  function handleKeyDown(e) {
    if (!showList) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(matches[activeIdx].name);
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
    }
  }

  // Reset active index when matches change
  useEffect(() => { setActiveIdx(0); }, [matches.length]);

  return (
    <div className="client-autocomplete-wrap">
      <input
        className="inbox-edit-input"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        placeholder="Client name"
      />
      {showList && (
        <ul className="client-autocomplete-list">
          {matches.map((c, i) => (
            <li
              key={c.id}
              className={`client-autocomplete-item${i === activeIdx ? " active" : ""}`}
              onMouseDown={() => select(c.name)}
            >
              {c.name}
              {c.short_name && c.short_name !== c.name && (
                <span className="client-autocomplete-short">{c.short_name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DIVISIONS = [
  "WordFlux", "WatchThreat", "AmPen", "Bedford AI", "ADA Web Work", "Linnflux", "FluxCC", "unknown",
];

const STATUS_COLORS = {
  classified: { bg: "#1e3a5f", text: "#60a5fa", label: "Classified" },
  dispatched: { bg: "#1a3a2a", text: "#4ade80", label: "Running" },
  done:       { bg: "#1a2e1a", text: "#86efac", label: "Done" },
  error:      { bg: "#3b1a1a", text: "#f87171", label: "Error" },
  deployed:   { bg: "#1a2a3a", text: "#38bdf8", label: "Deployed" },
};

function extractDomain(fromAddr) {
  const m = fromAddr?.match(/<([^>]+)>/) || fromAddr?.match(/(\S+@\S+)/);
  const email = m ? m[1] : fromAddr || "";
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase().trim() : "";
}

function LogPanel({ lines, exists }) {
  const preRef = useRef(null);
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines]);
  return (
    <pre className="inbox-modal-log" ref={preRef}>
      {exists ? (lines || "") : "Waiting for session output…"}
    </pre>
  );
}

export default function InboxModal({ item, onClose, onDismiss, onUpdate, onRedispatch, onProjectClick }) {
  const [draft, setDraft] = useState({
    client_hint: item.client_hint || "",
    division_hint: item.division_hint || "unknown",
    priority: item.priority || "normal",
    notes: item.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [redispatching, setRedispatching] = useState(false);
  const [redispatched, setRedispatched] = useState(false);
  const [redispatchError, setRedispatchError] = useState(null);
  const [aliasPrompt, setAliasPrompt] = useState(null); // { domain, client_hint, division_hint }
  const [aliasSaved, setAliasSaved] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveResult, setApproveResult] = useState(null); // { ok } | { error }
  const [deployApproving, setDeployApproving] = useState(false);
  const [deployResult, setDeployResult] = useState(null); // { ok } | { error }
  const [logLines, setLogLines] = useState("");
  const [logExists, setLogExists] = useState(false);
  const { companies } = useCompaniesList();

  // Reset draft when item changes (modal reused for different items)
  useEffect(() => {
    setDraft({
      client_hint: item.client_hint || "",
      division_hint: item.division_hint || "unknown",
      priority: item.priority || "normal",
      notes: item.notes || "",
    });
    setAliasPrompt(null);
    setAliasSaved(false);
    setApproveResult(null);
    setDeployResult(null);
    setLogLines("");
    setLogExists(false);
  }, [item.id]);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Poll session log while dispatched
  useEffect(() => {
    if (!item.session_name) return;
    if (!["dispatched", "done", "error"].includes(item.status)) return;

    async function fetchLog() {
      try {
        const r = await fetch(`/api/inbox/${item.id}/log?tail=80`);
        if (!r.ok) return;
        const data = await r.json();
        setLogLines(data.lines || "");
        setLogExists(data.exists || false);
      } catch (_) {}
    }

    fetchLog();
    if (item.status !== "dispatched") return;
    const interval = setInterval(fetchLog, 3000);
    return () => clearInterval(interval);
  }, [item.id, item.session_name, item.status]);

  const st = STATUS_COLORS[item.status] || STATUS_COLORS.classified;
  const from = item.from_addr || "";

  function changed() {
    return (
      draft.client_hint !== (item.client_hint || "") ||
      draft.division_hint !== (item.division_hint || "unknown") ||
      draft.priority !== (item.priority || "normal") ||
      draft.notes !== (item.notes || "")
    );
  }

  async function handleSave() {
    if (!changed()) return;
    setSaving(true);
    const fieldsToSave = { ...draft };
    try {
      await onUpdate(item.id, fieldsToSave);
      // If client_hint changed, offer alias prompt
      if (draft.client_hint !== (item.client_hint || "")) {
        const domain = extractDomain(item.from_addr);
        if (domain) {
          setAliasPrompt({
            domain,
            client_hint: draft.client_hint,
            division_hint: draft.division_hint !== "unknown" ? draft.division_hint : null,
          });
        }
      } else {
        setAliasPrompt(null);
      }
    } catch (_) {
      // error handled in hook (reverts optimistic update)
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAlias() {
    if (!aliasPrompt) return;
    try {
      await fetch("/api/client-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_type: "domain",
          match_value: aliasPrompt.domain,
          client_hint: aliasPrompt.client_hint,
          division_hint: aliasPrompt.division_hint,
          note: `From inbox card #${item.id}`,
        }),
      });
      setAliasSaved(true);
    } catch (_) {}
  }

  async function handleRedispatch() {
    setRedispatching(true);
    setRedispatched(false);
    setRedispatchError(null);
    try {
      await onRedispatch(item.id);
      setRedispatched(true);
    } catch (e) {
      setRedispatchError(e?.message || "Redispatch failed");
    } finally {
      setRedispatching(false);
    }
  }

  function handleLaunch() {
    const session = item.session_name;
    if (!session) return;
    window.location.href = `opendia://tmux/${encodeURIComponent(session)}`;
    setTimeout(() => {
      const cmd = `ssh linnflux@opendia -t 'tmux attach -t ${session} || tmux new-session -s ${session}'`;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(cmd);
      }
    }, 500);
  }

  const isServerWork = item.requires_server_access === 1 || item.requires_server_access === true;
  const canRedispatch = ["classified", "done", "error", "dispatched"].includes(item.status) && !isServerWork;
  const hasPreview = !!item.dev_preview_url;

  async function handleApproveDeploy() {
    setDeployApproving(true);
    setDeployResult(null);
    try {
      const r = await fetch(`/api/inbox/${item.id}/approve-deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Deploy failed");
      setDeployResult({ ok: true });
    } catch (e) {
      setDeployResult({ error: e.message || "Deploy failed" });
    } finally {
      setDeployApproving(false);
    }
  }

  async function handleApproveServer() {
    setApproving(true);
    setApproveResult(null);
    try {
      const r = await fetch(`/api/inbox/${item.id}/approve-server`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Approval failed");
      setApproveResult({ ok: true });
    } catch (e) {
      setApproveResult({ error: e.message || "Approval failed" });
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal inbox-modal">
        <div className="modal-top-actions">
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Header */}
        <div className="inbox-modal-subject">{item.subject || "(no subject)"}</div>
        <div className="inbox-modal-from">{from}</div>
        {item.project_name && (
          <div
            className={`inbox-modal-project-link${onProjectClick ? " clickable" : ""}`}
            onClick={() => onProjectClick && (onProjectClick(item.project_id), onClose())}
            title={onProjectClick ? "Open project card" : undefined}
          >
            &#8618; {item.project_name}
          </div>
        )}

        {/* Status + meta row */}
        <div className="inbox-modal-meta">
          <span className="inbox-card-status" style={{ background: st.bg, color: st.text }}>
            {st.label}
          </span>
          <span className="modal-id">{item.created_at?.slice(0, 16).replace("T", " ")}</span>
        </div>

        {/* Editable classification fields */}
        <div className="modal-section">
          <span className="modal-label">Classification</span>
          <div className="inbox-edit-grid">
            <div className="inbox-edit-field">
              <label className="inbox-edit-label">Client</label>
              <ClientAutocomplete
                value={draft.client_hint}
                onChange={(v) => setDraft((d) => ({ ...d, client_hint: v }))}
                companies={companies}
              />
            </div>
            <div className="inbox-edit-field">
              <label className="inbox-edit-label">Division</label>
              <select
                className="inbox-edit-select"
                value={draft.division_hint}
                onChange={(e) => setDraft((d) => ({ ...d, division_hint: e.target.value }))}
              >
                {DIVISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="inbox-edit-field">
              <label className="inbox-edit-label">Priority</label>
              <select
                className="inbox-edit-select"
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
              >
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
        </div>

        {/* Directive */}
        <div className="modal-section">
          <span className="modal-label">Directive</span>
          <div className="inbox-modal-prompt">{item.prompt_text || "(no directive)"}</div>
        </div>

        {/* Notes */}
        <div className="modal-section">
          <span className="modal-label">Operator Notes</span>
          <textarea
            className="inbox-edit-notes"
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            placeholder="Corrections, context, or instructions for re-dispatch…"
            rows={3}
          />
        </div>

        {/* Alias prompt */}
        {aliasPrompt && !aliasSaved && (
          <div className="inbox-alias-banner">
            <span>Save <strong>{aliasPrompt.client_hint}</strong> as the default client for <em>{aliasPrompt.domain}</em> going forward?</span>
            <div className="inbox-alias-actions">
              <button className="inbox-alias-btn" onClick={handleSaveAlias}>Save alias</button>
              <button className="inbox-alias-dismiss" onClick={() => setAliasPrompt(null)}>Skip</button>
            </div>
          </div>
        )}
        {aliasSaved && (
          <div className="inbox-alias-banner inbox-alias-saved">
            Alias saved — future emails from {aliasPrompt?.domain} will classify as {aliasPrompt?.client_hint}.
          </div>
        )}

        {/* Error */}
        {item.error_text && (
          <div className="modal-section">
            <span className="modal-label">Error</span>
            <div className="inbox-modal-error">{item.error_text}</div>
          </div>
        )}

        {/* Session */}
        {item.session_name && (
          <div className="modal-section">
            <span className="modal-label">Session</span>
            <div className="modal-tmux-row">
              <span className="card-tmux">{item.session_name}</span>
              <button className="modal-launch-btn" onClick={handleLaunch}>
                ⬡ Attach
              </button>
            </div>
          </div>
        )}

        {/* Session Log */}
        {item.session_name && ["dispatched", "done", "error"].includes(item.status) && (
          <div className="modal-section">
            <span className="modal-label">Session Log</span>
            <LogPanel lines={logLines} exists={logExists} />
          </div>
        )}

        {/* FluxCC dev preview + deploy */}
        {hasPreview && (
          <div className="inbox-server-gate">
            <div className="inbox-server-gate-body">
              <span className="inbox-card-server-flag" style={{ background: "#1e3a5f", color: "#60a5fa" }}>PREVIEW</span>
              <span className="inbox-server-gate-info">
                <a href={item.dev_preview_url} target="_blank" rel="noopener noreferrer" style={{ color: "#38bdf8", wordBreak: "break-all" }}>
                  {item.dev_preview_url}
                </a>
                {item.dev_branch && <span style={{ marginLeft: "0.5em", opacity: 0.6, fontSize: "0.85em" }}>({item.dev_branch})</span>}
              </span>
              {item.status !== "deployed" && (
                <button
                  className="inbox-approve-btn"
                  style={{ background: "#166534", color: "#4ade80" }}
                  onClick={handleApproveDeploy}
                  disabled={deployApproving}
                >
                  {deployApproving ? "Deploying…" : "Approve & Deploy"}
                </button>
              )}
              {item.status === "deployed" && (
                <span className="inbox-card-status" style={{ background: "#1a2a3a", color: "#38bdf8" }}>Deployed</span>
              )}
            </div>
            {deployResult?.ok && (
              <div className="inbox-server-result inbox-server-result-ok">
                Merged to main — production deploy triggered.
              </div>
            )}
            {deployResult?.error && (
              <div className="inbox-server-result inbox-server-result-err">
                {deployResult.error}
              </div>
            )}
          </div>
        )}

        {/* Server-work gate */}
        {isServerWork && ["classified", "error"].includes(item.status) && (
          <div className="inbox-server-gate">
            <div className="inbox-server-gate-body">
              <span className="inbox-card-server-flag">SERVER</span>
              <span className="inbox-server-gate-info">
                {item.status === "error"
                  ? "Previous server-work run errored. Review the directive and notes above, then re-dispatch."
                  : "This task requires server access. Review the directive above, then approve to dispatch."}
              </span>
              <button
                className="inbox-approve-btn"
                onClick={handleApproveServer}
                disabled={approving}
              >
                {approving
                  ? "Dispatching…"
                  : item.status === "error"
                    ? "↺ Re-dispatch"
                    : "Approve & Dispatch"}
              </button>
            </div>
            {approveResult?.ok && (
              <div className="inbox-server-result inbox-server-result-ok">
                Session spawning — check <code>tmux ls | grep inbox-</code> in a moment.
              </div>
            )}
            {approveResult?.error && (
              <div className="inbox-server-result inbox-server-result-err">
                {approveResult.error}
              </div>
            )}
          </div>
        )}

        {/* Re-dispatch feedback */}
        {redispatched && (
          <div className="inbox-redispatch-banner inbox-redispatch-ok">
            Session spawning — check <code>tmux ls | grep inbox-</code> in a moment.
          </div>
        )}
        {redispatchError && (
          <div className="inbox-redispatch-banner inbox-redispatch-err">
            Re-dispatch failed: {redispatchError}
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer inbox-modal-footer">
          <span className="modal-id">gmail:{item.gmail_id}</span>
          <div className="inbox-footer-actions">
            {changed() && (
              <button className="inbox-save-btn" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            )}
            {canRedispatch && (
              <button className="inbox-redispatch-btn" onClick={handleRedispatch} disabled={redispatching}>
                {redispatching ? "Dispatching…" : item.status === "classified" ? "▶ Dispatch" : "↺ Re-dispatch"}
              </button>
            )}
            <button className="inbox-dismiss-btn" onClick={() => { onDismiss && onDismiss(item.id); onClose(); }}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
