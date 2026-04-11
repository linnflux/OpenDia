import { useEffect } from "react";

const STATUS_COLORS = {
  classified: { bg: "#1e3a5f", text: "#60a5fa", label: "Classified" },
  dispatched: { bg: "#1a3a2a", text: "#4ade80", label: "Running" },
  done:       { bg: "#1a2e1a", text: "#86efac", label: "Done" },
  error:      { bg: "#3b1a1a", text: "#f87171", label: "Error" },
};

export default function InboxModal({ item, onClose, onDismiss }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const st = STATUS_COLORS[item.status] || STATUS_COLORS.classified;
  const from = item.from_addr || "";

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

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal inbox-modal">
        <div className="modal-top-actions">
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Header */}
        <div className="inbox-modal-subject">{item.subject || "(no subject)"}</div>
        <div className="inbox-modal-from">{from}</div>

        {/* Status + meta row */}
        <div className="inbox-modal-meta">
          <span className="inbox-card-status" style={{ background: st.bg, color: st.text }}>
            {st.label}
          </span>
          {item.client_hint && item.client_hint !== "unknown" && (
            <span className="inbox-modal-badge">{item.client_hint}</span>
          )}
          {item.division_hint && item.division_hint !== "unknown" && (
            <span className="inbox-modal-badge">{item.division_hint}</span>
          )}
          {item.priority && item.priority !== "normal" && (
            <span className="inbox-modal-badge" style={{ color: item.priority === "high" ? "#f87171" : "#94a3b8" }}>
              {item.priority} priority
            </span>
          )}
          <span className="modal-id">{item.created_at?.slice(0, 16).replace("T", " ")}</span>
        </div>

        {/* Directive */}
        <div className="modal-section">
          <span className="modal-label">Directive</span>
          <div className="inbox-modal-prompt">{item.prompt_text || "(no directive)"}</div>
        </div>

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

        {/* Footer */}
        <div className="modal-footer inbox-modal-footer">
          <span className="modal-id">gmail:{item.gmail_id}</span>
          <button className="inbox-dismiss-btn" onClick={() => { onDismiss(item.id); onClose(); }}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
