import { useState, useRef, useEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TAGS, hasTag } from "../tags.js";
import { DIVISION_COLORS, STATUS_OPTIONS } from "../constants.js";

const INBOX_PREFIX = "Auto-created from inbox: ";

// The whole card is the drag handle, which means every nested control sits
// inside a pointerdown listener that would start a drag. Stopping propagation
// on those keeps buttons and menus behaving like buttons and menus.
const noDrag = { onPointerDown: (e) => e.stopPropagation() };

export default function Card({ project, onClick, hasActiveTimer, onStatusChange, onToggleTag, sortable }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: project.id, disabled: !sortable });

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

  // Enter opens the card; Space is handed to dnd-kit's keyboard sensor to
  // pick up / drop, with the arrow keys moving it. Both need to live on the
  // same element, and dnd-kit's own onKeyDown would otherwise swallow Enter.
  function handleCardKeyDown(e) {
    if (e.target !== e.currentTarget) return; // let nested buttons handle their own keys
    if (e.key === "Enter") {
      e.preventDefault();
      handleCardClick(e);
      return;
    }
    listeners?.onKeyDown?.(e);
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
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.35 } : {}),
      }}
      className={`card${hasActiveTimer ? " card-timer-active" : ""}${isDragging ? " card-dragging" : ""}${sortable ? " card-sortable" : ""}`}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
    >
      <span className="card-corner">
        {TAGS.map((tag) => {
          const on = hasTag(project, tag.key);
          return (
            <button
              key={tag.key}
              className={`card-tag-t${on ? " on" : ""}`}
              style={on ? { backgroundColor: tag.color } : {}}
              title={on ? `Tagged for ${tag.label} — click to untag` : `Tag for ${tag.label}`}
              onClick={(e) => { e.stopPropagation(); onToggleTag && onToggleTag(project, tag.key); }}
              {...noDrag}
            >
              {tag.letter}
            </button>
          );
        })}
        {inboxSource && (
          <span className="card-inbox-origin" title={`Created from inbox: ${inboxSource}`}>
            <img src="/opendia_mark.svg" width="12" height="9" alt="" aria-hidden="true" />
          </span>
        )}
      </span>
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
              {...noDrag}
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
                    {...noDrag}
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
