import { useState, useEffect, useRef } from "react";

const STATUSES = [
  { key: "in_progress", label: "In Progress", color: "#3b82f6" },
  { key: "wfhuman", label: "WFHuman", color: "#f59e0b" },
  { key: "ice", label: "Ice", color: "#6b7280" },
  { key: "completed", label: "Completed", color: "#22c55e" },
];

function NotionIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6.017 4.313l55.333-4.087c6.797-.583 8.543-.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277-1.553 6.807-6.99 7.193L24.467 99.967c-4.08.193-6.023-.39-8.16-3.113L3.3 79.94c-2.333-3.113-3.3-5.443-3.3-8.167V11.113c0-3.497 1.553-6.413 6.017-6.8z" fill="#fff"/>
      <path d="M61.35.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.723.967 5.053 3.3 8.167l13.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113l64.257-3.89c5.433-.387 6.99-2.917 6.99-7.193V20.64c0-2.21-.873-2.847-3.443-4.733L75.24 3.57C71.1-.26 69.36-.56 61.35.227zM25.33 19.2c-5.2.33-6.38.407-9.34-1.95L8.88 11.5c-.78-.78-.39-1.75 1.75-1.95l51.25-3.69c4.47-.39 6.8 1.17 8.54 2.53l8.54 6.22c.39.2.97 1.36 0 1.36l-52.87 3.11-.76.12zM19.7 88.42V33.6c0-2.53.78-3.7 3.11-3.89l58.47-3.3c2.14-.2 3.11 1.17 3.11 3.7v54.43c0 2.53-1.37 4.86-4.47 5.05L26.5 92.1c-3.11.2-6.8-1.17-6.8-3.7zm52.07-51.34c.39 1.75 0 3.5-1.75 3.7l-2.72.58v40.14c-2.33 1.17-4.47 1.95-6.21 1.95-2.92 0-3.7-.97-5.83-3.5L38.17 52.63v24.27l5.63 1.36s0 3.3-4.67 3.3l-12.83.78c-.39-.78 0-2.73 1.36-3.11l3.3-.97V44.6l-4.67-.39c-.39-1.75.58-4.28 3.3-4.47l13.8-.97 18.33 28.14V44.8l-4.67-.58c-.39-2.14 1.17-3.7 3.11-3.89l13.03-.78z" fill="#000"/>
    </svg>
  );
}

const DIVISION_COLORS = {
  WordFlux: { bg: "#3b82f6", text: "#0a1628" },
  WatchThreat: { bg: "#5e97f2", text: "#fff" },
  AmPen: { bg: "#5a7a94", text: "#fff" },
  "Bedford AI": { bg: "#f5f0e8", text: "#2b0000" },
  "ADA Web Work": { bg: "#15489f", text: "#fff" },
  Linnflux: { bg: "#54af4d", text: "#fff" },
};

function TimerEntry({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = !entry.end;
  const hasNotes = !!entry.notes;
  return (
    <div
      className={`timer-entry ${isRunning ? "timer-open" : ""} ${hasNotes ? "timer-expandable" : ""} ${expanded ? "timer-expanded" : ""}`}
    >
      <div className="timer-header" onClick={() => hasNotes && setExpanded((v) => !v)}>
        {hasNotes && <span className="timer-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>}
        <span className="timer-date">{entry.date}</span>
        <span className="timer-duration">
          {entry.estimated_minutes ? `${entry.estimated_minutes}m` : "\u2014"}
        </span>
        {entry.billable && <span className="timer-billable">$</span>}
      </div>
      {entry.task && <div className="timer-task">{entry.task}</div>}
      {expanded && entry.notes && (
        <ul className="timer-notes-list">
          {entry.notes.split("\n").filter(Boolean).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const IMG_RE = /(~\/OpenDia\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|svg))/gi;

function extractImagePaths(...fields) {
  const paths = [];
  for (const text of fields) {
    if (!text) continue;
    for (const match of text.matchAll(IMG_RE)) {
      if (!paths.includes(match[1])) paths.push(match[1]);
    }
  }
  return paths;
}

export default function CardModal({ project, onClose, onUpdate, hasActiveTimer }) {
  const [name, setName] = useState(project.name || "");
  const [editingName, setEditingName] = useState(false);
  const [notes, setNotes] = useState(project.notes || "");
  const [tmux, setTmux] = useState(project.tmux_session || "");
  const [nextStep, setNextStep] = useState(project.next_step || "");
  const [editingNotes, setEditingNotes] = useState(false);
  const [editingTmux, setEditingTmux] = useState(false);
  const [editingNextStep, setEditingNextStep] = useState(false);
  const [timers, setTimers] = useState([]);
  const [timersLoading, setTimersLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncData, setSyncData] = useState(null);
  const [notionTitle, setNotionTitle] = useState(null);
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

  useEffect(() => {
    if (!project.notion_id) return;
    fetch(`/api/projects/${project.id}/notion-title`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d?.title && setNotionTitle(d.title))
      .catch(() => {});
  }, [project.id, project.notion_id]);

  function handleBackdropClick(e) {
    if (e.target === backdropRef.current) onClose();
  }

  function saveName() {
    setEditingName(false);
    if (name.trim() && name !== (project.name || "")) {
      onUpdate(project.id, { name: name.trim() });
    } else {
      setName(project.name || "");
    }
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

  function saveNextStep() {
    setEditingNextStep(false);
    if (nextStep !== (project.next_step || "")) {
      onUpdate(project.id, { next_step: nextStep || null });
    }
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  function handleLaunch() {
    const session = project.tmux_session;
    if (!session) return;

    // Try custom protocol first
    const protoUrl = `opendia://tmux/${encodeURIComponent(session)}`;
    window.location.href = protoUrl;

    // After a short delay, copy the SSH command as fallback
    // (if the protocol handler opened, the user won't need this)
    setTimeout(() => {
      const cmd = `ssh linnflux@opendia -t 'tmux attach -t ${session} || tmux new-session -s ${session}'`;
      try {
        // navigator.clipboard requires secure context (HTTPS/localhost)
        // Fall back to execCommand for HTTP connections
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(cmd).then(() => {
            showToast("Command copied to clipboard");
          });
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = cmd;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
          showToast("Command copied to clipboard");
        }
      } catch {
        showToast(cmd);
      }
    }, 500);
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/sync`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setSyncData(data);
        // Update local next_step if AI changed it
        if (data.updated?.next_step) {
          setNextStep(data.updated.next_step);
          onUpdate(project.id, { next_step: data.updated.next_step });
        }
        // If Notion task was auto-discovered, update local state and refresh title
        if (data.updated?.notion_id) {
          project.notion_id = data.updated.notion_id;
          onUpdate(project.id, { notion_id: data.updated.notion_id });
          fetch(`/api/projects/${project.id}/notion-title`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => d?.title && setNotionTitle(d.title))
            .catch(() => {});
        }
        const parts = [];
        if (data.emails?.length) parts.push(`${data.emails.length} email(s)`);
        if (data.analysis?.changeRequests?.length) parts.push(`${data.analysis.changeRequests.length} change request(s)`);
        if (data.updated?.notion_appended) parts.push("Notion updated");
        showToast(parts.length ? `Synced: ${parts.join(", ")}` : "Synced — no new activity");
      } else {
        showToast("Sync failed");
      }
    } catch (err) {
      console.error("sync error:", err);
      showToast("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const div = DIVISION_COLORS[project.division] || { bg: "#6b7280", text: "#fff" };

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      <div className={`modal${hasActiveTimer ? " modal-timer-active" : ""}`}>
        <div className="modal-top-actions">
          <button
            className={`modal-sync-btn ${syncing ? "syncing" : ""}`}
            onClick={handleSync}
            disabled={syncing}
            title="Refresh from Notion & email"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        {editingName ? (
          <input
            className="modal-title-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && saveName()}
            autoFocus
          />
        ) : (
          <h2 className="modal-title clickable" onClick={() => setEditingName(true)}>{name}</h2>
        )}

        <div className="modal-meta">
          {project.company_notion_id ? (
            <a
              className="modal-company modal-company-link"
              href={`https://www.notion.so/${project.company_notion_id.replace(/-/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open company in Notion"
            >
              {project.company_name || "No company"}
            </a>
          ) : (
            <span className="modal-company">
              {project.company_name || "No company"}
            </span>
          )}
          {project.division && (
            <span className="card-division" style={{ backgroundColor: div.bg, color: div.text }}>
              {project.division}
            </span>
          )}
          {project.notion_id && (
            <a
              className="modal-notion-link"
              href={`https://www.notion.so/${project.notion_id.replace(/-/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open task in Notion"
            >
              <NotionIcon size={16} />
              {notionTitle && <span className="modal-notion-title">{notionTitle}</span>}
            </a>
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
            <div className="modal-tmux-row">
              <div className="modal-value clickable" onClick={() => setEditingTmux(true)} style={{ flex: 1 }}>
                {project.tmux_session ? (
                  <span className="card-tmux">{project.tmux_session}</span>
                ) : (
                  <span className="modal-empty">Click to set</span>
                )}
              </div>
              {project.tmux_session && (
                <button className="modal-launch-btn" title="Launch tmux session" onClick={handleLaunch}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  Launch
                </button>
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
          <label className="modal-label">Next Step</label>
          {editingNextStep ? (
            <div className="modal-inline-edit">
              <input
                className="modal-input"
                value={nextStep}
                onChange={(e) => setNextStep(e.target.value)}
                onBlur={saveNextStep}
                onKeyDown={(e) => e.key === "Enter" && saveNextStep()}
                placeholder="What's the next action?"
                autoFocus
              />
            </div>
          ) : (
            <div className="modal-value clickable" onClick={() => setEditingNextStep(true)}>
              {project.next_step ? (
                <span className="modal-next-step">{project.next_step}</span>
              ) : (
                <span className="modal-empty">Click to set next step</span>
              )}
            </div>
          )}
        </div>

        {extractImagePaths(project.notes, project.next_step).length > 0 && (
          <div className="modal-section">
            <label className="modal-label">Attachments</label>
            <div className="attachment-grid">
              {extractImagePaths(project.notes, project.next_step).map((path) => (
                <a
                  key={path}
                  className="attachment-preview"
                  href={`/api/file?path=${encodeURIComponent(path)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    src={`/api/file?path=${encodeURIComponent(path)}`}
                    alt={path.split("/").pop()}
                  />
                  <span className="attachment-name">{path.split("/").pop()}</span>
                </a>
              ))}
            </div>
          </div>
        )}

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

        {syncData && (
          <div className="modal-section sync-results">
            <label className="modal-label">Sync Results</label>

            {syncData.updated?.notion_id && (
              <div className="sync-meta" style={{ color: "#22c55e", fontWeight: 500, marginBottom: "0.5rem" }}>
                Linked Notion task{syncData.notion?.title ? `: ${syncData.notion.title}` : ""}
              </div>
            )}

            {syncData.notion && (
              <div className="sync-notion">
                <div className="sync-notion-header">
                  <NotionIcon size={14} />
                  <span className="sync-notion-title">{syncData.notion.title || "Untitled"}</span>
                  {syncData.notion.status && (
                    <span className="sync-notion-status">{syncData.notion.status}</span>
                  )}
                </div>
                {syncData.notion.last_edited && (
                  <div className="sync-meta">
                    Edited {new Date(syncData.notion.last_edited).toLocaleDateString()}
                  </div>
                )}
                {syncData.notion.todos.length > 0 && (
                  <ul className="sync-todos">
                    {syncData.notion.todos.map((todo, i) => (
                      <li key={i} className={todo.checked ? "todo-done" : ""}>
                        <span className="todo-check">{todo.checked ? "\u2611" : "\u2610"}</span>
                        {todo.text}
                      </li>
                    ))}
                  </ul>
                )}
                {syncData.notion.comments.length > 0 && (
                  <div className="sync-comments">
                    <div className="sync-sub-label">Recent comments</div>
                    {syncData.notion.comments.map((c, i) => (
                      <div key={i} className="sync-comment">
                        <span className="sync-comment-text">{c.text}</span>
                        <span className="sync-comment-date">
                          {new Date(c.created).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {syncData.notion.url && (
                  <a className="sync-notion-link" href={syncData.notion.url} target="_blank" rel="noopener noreferrer">
                    Open in Notion
                  </a>
                )}
              </div>
            )}

            {syncData.emails?.length > 0 && (
              <div className="sync-emails">
                <div className="sync-sub-label">Recent Emails ({syncData.emails.length})</div>
                {syncData.emails.map((e) => (
                  <a key={e.id} className="sync-email" href={e.threadUrl} target="_blank" rel="noopener noreferrer">
                    <div className="sync-email-subject">{e.subject}</div>
                    <div className="sync-email-meta">
                      <span className="sync-email-from">{e.from.replace(/<[^>]+>/, "").trim()}</span>
                      <span className="sync-email-date">{new Date(e.date).toLocaleDateString()}</span>
                    </div>
                  </a>
                ))}
              </div>
            )}

            {syncData.analysis && (
              <div className="sync-analysis">
                {syncData.analysis.changeRequests?.length > 0 && (
                  <div className="sync-changes">
                    <div className="sync-sub-label">Change Requests Detected</div>
                    {syncData.analysis.changeRequests.map((cr, i) => (
                      <div key={i} className="sync-change">
                        <div className="sync-change-summary">{cr.summary}</div>
                        <div className="sync-change-detail">{cr.detail}</div>
                      </div>
                    ))}
                    {syncData.updated?.notion_appended && (
                      <div className="sync-meta" style={{ marginTop: "0.25rem" }}>Added to Notion task</div>
                    )}
                  </div>
                )}
                {syncData.analysis.reasoning && (
                  <div className="sync-reasoning">{syncData.analysis.reasoning}</div>
                )}
              </div>
            )}

            {!syncData.notion && !syncData.emails?.length && (
              <div className="modal-empty">No Notion page or email data linked</div>
            )}
          </div>
        )}

        <div className="modal-footer">
          <span className="modal-id">ID: {project.id}</span>
          {project.notion_id && (
            <a
              className="modal-notion-link"
              href={`https://www.notion.so/${project.notion_id.replace(/-/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in Notion"
              style={{ marginLeft: "auto" }}
            >
              <NotionIcon size={14} />
              <span style={{ marginLeft: "0.25rem", fontSize: "0.7rem", color: "#64748b" }}>Notion</span>
            </a>
          )}
        </div>
        {toast && <div className="modal-toast">{toast}</div>}
      </div>
    </div>
  );
}
