import { useState, useRef, useEffect } from "react";

const DIVISION_COLORS = {
  WordFlux: { bg: "#111111", text: "#ffffff", uppercase: true },
  WatchThreat: { bg: "#5e97f2", text: "#fff" },
  AmPen: { bg: "#5a7a94", text: "#fff" },
  "Bedford AI": { bg: "#f5f0e8", text: "#2b0000" },
  "ADA Web Work": { bg: "#15489f", text: "#fff" },
  Linnflux: { bg: "#54af4d", text: "#fff" },
  FluxCC: { bg: "#2d1a0e", text: "#d4a528" },
};

const STATUS_OPTIONS = [
  { key: "in_progress", label: "In Progress", color: "#3b82f6" },
  { key: "wfhuman",    label: "WFHuman",     color: "#f59e0b" },
  { key: "ice",        label: "Ice",          color: "#6b7280" },
  { key: "completed",  label: "Completed",    color: "#22c55e" },
];

const INBOX_PREFIX = "Auto-created from inbox: ";

export default function Card({ project, onClick, hasActiveTimer, onStatusChange }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [menuOpen]);

  const div = DIVISION_COLORS[project.division] || { bg: "#6b7280", text: "#fff" };
  const inboxSource = project.notes?.startsWith(INBOX_PREFIX)
    ? project.notes.slice(INBOX_PREFIX.length)
    : null;
  const currentStatus = STATUS_OPTIONS.find((s) => s.key === project.status);

  function handleCardClick(e) {
    if (onClick) onClick(project);
  }

  function handlePillClick(e) {
    e.stopPropagation();
    setMenuOpen((v) => !v);
  }

  function handleStatusSelect(e, key) {
    e.stopPropagation();
    setMenuOpen(false);
    if (key !== project.status && onStatusChange) onStatusChange(project.id, key);
  }

  return (
    <div className={`card${hasActiveTimer ? " card-timer-active" : ""}`} onClick={handleCardClick}>
      {inboxSource && (
        <span className="card-inbox-origin" title={`Created from inbox: ${inboxSource}`}>
          <img src="/opendia_mark.svg" width="12" height="9" alt="" aria-hidden="true" />
        </span>
      )}
      <div className="card-name">{project.name}</div>
      <div className="card-company">{project.company_name || "No company"}</div>
      <div className="card-badges">
        {project.division && (
          <span
            className="card-division"
            style={{
              backgroundColor: div.bg,
              color: div.text,
              ...(div.uppercase ? { textTransform: "uppercase" } : {}),
            }}
          >
            {project.division}
          </span>
        )}
        {project.inbox_count > 0 && (
          <span className="card-inbox-badge" title={`${project.inbox_count} active inbox item(s)`}>
            {project.inbox_count}
          </span>
        )}
        {currentStatus && (
          <span className="card-status-pill-wrap" ref={menuRef}>
            <button
              className="card-status-pill"
              style={{ borderColor: currentStatus.color, color: currentStatus.color }}
              onClick={handlePillClick}
              title="Change status"
            >
              {currentStatus.label}
              <span className="card-status-caret">▾</span>
            </button>
            {menuOpen && (
              <div className="card-status-menu">
                {STATUS_OPTIONS.map((s) => (
                  <button
                    key={s.key}
                    className={`card-status-option${s.key === project.status ? " active" : ""}`}
                    style={{ color: s.color }}
                    onClick={(e) => handleStatusSelect(e, s.key)}
                  >
                    <span className="card-status-dot" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
      </div>
      {project.next_step && (
        <div className="card-next-step">
          <span className="card-next-arrow">&rarr;</span>
          {project.next_step.slice(0, 80)}{project.next_step.length > 80 ? "..." : ""}
        </div>
      )}
      {project.tmux_session && (
        <div className="card-tmux-row">
          <span className="card-tmux">{project.tmux_session}</span>
        </div>
      )}
    </div>
  );
}
