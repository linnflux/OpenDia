import { useState, useEffect, useRef } from "react";

const STATUSES = [
  { key: "in_progress", label: "In Progress", color: "#3b82f6" },
  { key: "wfhuman", label: "WFHuman", color: "#f59e0b" },
  { key: "completed", label: "Completed", color: "#22c55e" },
  { key: "ice", label: "Ice", color: "#6b7280" },
];

const DIVISION_COLORS = {
  WordFlux: "#3b82f6",
  WatchThreat: "#ef4444",
  AmPen: "#8b5cf6",
  "Bedford AI": "#06b6d4",
  "ADA Web Work": "#f59e0b",
};

function TimerEntry({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = !entry.end;
  const hasNotes = !!entry.notes;
  return (
    <div
      className={`timer-entry ${isRunning ? "timer-open" : ""} ${hasNotes ? "timer-expandable" : ""} ${expanded ? "timer-expanded" : ""}`}
      onClick={() => hasNotes && setExpanded((v) => !v)}
    >
      <div className="timer-header">
        {hasNotes && <span className="timer-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>}
        <span className="timer-date">{entry.date}</span>
        <span className="timer-duration">
          {entry.estimated_minutes ? `${entry.estimated_minutes}m` : "\u2014"}
        </span>
        {entry.billable && <span className="timer-billable">$</span>}
      </div>
      {entry.task && <div className="timer-task">{entry.task}</div>}
      {expanded && entry.notes && <div className="timer-notes">{entry.notes}</div>}
    </div>
  );
}

export default function CardModal({ project, onClose, onUpdate }) {
  const [notes, setNotes] = useState(project.notes || "");
  const [tmux, setTmux] = useState(project.tmux_session || "");
  const [editingNotes, setEditingNotes] = useState(false);
  const [editingTmux, setEditingTmux] = useState(false);
  const [timers, setTimers] = useState([]);
  const [timersLoading, setTimersLoading] = useState(true);
  const backdropRef = useRef(null);
  const notesRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (editingNotes && notesRef.current) notesRef.current.focus();
  }, [editingNotes]);

  useEffect(() => {
    async function fetchTimers() {
      try {
        const res = await fetch(`/api/projects/${project.id}/timers`);
        if (res.ok) setTimers(await res.json());
      } catch (err) {
        console.error("timer fetch error:", err);
      } finally {
        setTimersLoading(false);
      }
    }
    fetchTimers();
  }, [project.id]);

  function handleBackdropClick(e) {
    if (e.target === backdropRef.current) onClose();
  }

  function handleStatusChange(newStatus) {
    if (newStatus !== project.status) {
      onUpdate(project.id, { status: newStatus });
    }
  }

  function saveNotes() {
    setEditingNotes(false);
    if (notes !== (project.notes || "")) {
      onUpdate(project.id, { notes });
    }
  }

  function saveTmux() {
    setEditingTmux(false);
    if (tmux !== (project.tmux_session || "")) {
      onUpdate(project.id, { tmux_session: tmux || null });
    }
  }

  const divColor = DIVISION_COLORS[project.division] || "#6b7280";

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>&times;</button>

        <h2 className="modal-title">{project.name}</h2>

        <div className="modal-meta">
          <span className="modal-company">
            {project.company_name || "No company"}
            {project.company_short ? ` (${project.company_short})` : ""}
          </span>
          {project.division && (
            <span className="card-division" style={{ backgroundColor: divColor }}>
              {project.division}
            </span>
          )}
        </div>

        <div className="modal-section">
          <label className="modal-label">Status</label>
          <div className="modal-status-row">
            {STATUSES.map((s) => (
              <button
                key={s.key}
                className={`modal-status-btn ${project.status === s.key ? "active" : ""}`}
                style={{
                  borderColor: s.color,
                  backgroundColor: project.status === s.key ? s.color : "transparent",
                  color: project.status === s.key ? "#fff" : s.color,
                }}
                onClick={() => handleStatusChange(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="modal-section">
          <label className="modal-label">Tmux Session</label>
          {editingTmux ? (
            <div className="modal-inline-edit">
              <input
                className="modal-input"
                value={tmux}
                onChange={(e) => setTmux(e.target.value)}
                onBlur={saveTmux}
                onKeyDown={(e) => e.key === "Enter" && saveTmux()}
                placeholder="e.g. WT-otr"
              />
            </div>
          ) : (
            <div className="modal-value clickable" onClick={() => setEditingTmux(true)}>
              {project.tmux_session ? (
                <span className="card-tmux">{project.tmux_session}</span>
              ) : (
                <span className="modal-empty">Click to set</span>
              )}
            </div>
          )}
        </div>

        <div className="modal-section">
          <label className="modal-label">Notes</label>
          {editingNotes ? (
            <div className="modal-notes-edit">
              <textarea
                ref={notesRef}
                className="modal-textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={saveNotes}
                rows={5}
              />
              <button className="modal-save-btn" onMouseDown={saveNotes}>Save</button>
            </div>
          ) : (
            <div className="modal-value clickable" onClick={() => setEditingNotes(true)}>
              {project.notes ? (
                <p className="modal-notes-text">{project.notes}</p>
              ) : (
                <span className="modal-empty">Click to add notes</span>
              )}
            </div>
          )}
        </div>

        <div className="modal-section">
          <label className="modal-label">
            Time Entries
            {timers.length > 0 && <span className="timer-count">{timers.length}</span>}
          </label>
          {timersLoading ? (
            <div className="modal-empty">Loading timers...</div>
          ) : timers.length === 0 ? (
            <div className="modal-empty">No matching timer entries found</div>
          ) : (
            <div className="timer-list">
              {timers.map((entry, i) => (
                <TimerEntry key={entry.start || i} entry={entry} />
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <span className="modal-id">ID: {project.id}</span>
        </div>
      </div>
    </div>
  );
}
