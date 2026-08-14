import { useState, useEffect, useRef } from "react";
import { marked } from "marked";
import TerminalPanel from "./TerminalPanel.jsx";
import SparkPanel from "./SparkPanel.jsx";
import useSparkRun from "../hooks/useSparkRun.js";
import { TAGS, hasTag, toggleTag } from "../tags.js";
import { DIVISION_COLORS, DIVISION_LOGOS, STATUS_OPTIONS as STATUSES } from "../constants.js";

marked.setOptions({ breaks: true, gfm: true });

function NotionIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6.017 4.313l55.333-4.087c6.797-.583 8.543-.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277-1.553 6.807-6.99 7.193L24.467 99.967c-4.08.193-6.023-.39-8.16-3.113L3.3 79.94c-2.333-3.113-3.3-5.443-3.3-8.167V11.113c0-3.497 1.553-6.413 6.017-6.8z" fill="#fff"/>
      <path d="M61.35.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.723.967 5.053 3.3 8.167l13.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113l64.257-3.89c5.433-.387 6.99-2.917 6.99-7.193V20.64c0-2.21-.873-2.847-3.443-4.733L75.24 3.57C71.1-.26 69.36-.56 61.35.227zM25.33 19.2c-5.2.33-6.38.407-9.34-1.95L8.88 11.5c-.78-.78-.39-1.75 1.75-1.95l51.25-3.69c4.47-.39 6.8 1.17 8.54 2.53l8.54 6.22c.39.2.97 1.36 0 1.36l-52.87 3.11-.76.12zM19.7 88.42V33.6c0-2.53.78-3.7 3.11-3.89l58.47-3.3c2.14-.2 3.11 1.17 3.11 3.7v54.43c0 2.53-1.37 4.86-4.47 5.05L26.5 92.1c-3.11.2-6.8-1.17-6.8-3.7zm52.07-51.34c.39 1.75 0 3.5-1.75 3.7l-2.72.58v40.14c-2.33 1.17-4.47 1.95-6.21 1.95-2.92 0-3.7-.97-5.83-3.5L38.17 52.63v24.27l5.63 1.36s0 3.3-4.67 3.3l-12.83.78c-.39-.78 0-2.73 1.36-3.11l3.3-.97V44.6l-4.67-.39c-.39-1.75.58-4.28 3.3-4.47l13.8-.97 18.33 28.14V44.8l-4.67-.58c-.39-2.14 1.17-3.7 3.11-3.89l13.03-.78z" fill="#000"/>
    </svg>
  );
}

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

function relativeTime(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso + "Z").getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const INBOX_STATUS_DOT = {
  classified: "#60a5fa",
  dispatched: "#4ade80",
  done: "#86efac",
  error: "#f87171",
  dismissed: "#475569",
};

export default function CardModal({ project, onClose, onUpdate, hasActiveTimer, onInboxItemClick, isAdmin, initialTab }) {
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
  const [inboxItems, setInboxItems] = useState([]);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [ingesting, setIngesting] = useState(null);
  const [toast, setToast] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState(null);
  const [notionTitle, setNotionTitle] = useState(null);
  const [divisionOpen, setDivisionOpen] = useState(false);
  const [tab, setTab] = useState(initialTab || "details");
  // Owned here, not in SparkPanel: panels unmount on every tab switch, and a
  // run has to survive a glance at Details.
  const spark = useSparkRun(project.id);
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
    async function fetchInbox() {
      try {
        const res = await fetch(`/api/projects/${project.id}/inbox`);
        if (res.ok) setInboxItems(await res.json());
      } catch (err) {
        console.error("inbox fetch error:", err);
      } finally {
        setInboxLoading(false);
      }
    }
    fetchInbox();
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
      copyText(cmd, "Command copied to clipboard");
    }, 500);
  }

  // navigator.clipboard needs a secure context. localhost qualifies, but
  // reaching the dashboard over Tailscale by IP does not, so keep the
  // execCommand fallback.
  function copyText(text, message) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => showToast(message));
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      showToast(message);
    } catch {
      showToast(text);
    }
  }

  async function handleReview() {
    setReviewing(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/review`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setReview(data);
        // Notion auto-discovery is the only server-side write; reflect it locally
        if (data.linked_notion) {
          onUpdate(project.id, {});
          fetch(`/api/projects/${project.id}/notion-title`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => d?.title && setNotionTitle(d.title))
            .catch(() => {});
        }
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Review failed");
      }
    } catch (err) {
      console.error("review error:", err);
      showToast("Review failed");
    } finally {
      setReviewing(false);
    }
  }

  function applyNextStepProposal() {
    const value = review?.proposals?.next_step?.value;
    if (!value) return;
    setNextStep(value);
    onUpdate(project.id, { next_step: value });
    setReview((prev) => prev && { ...prev, proposals: { ...prev.proposals, next_step: null } });
    showToast("Next step updated");
  }

  function applyStatusProposal() {
    const value = review?.proposals?.status?.value;
    if (!value) return;
    onUpdate(project.id, { status: value });
    setReview((prev) => prev && { ...prev, proposals: { ...prev.proposals, status: null } });
    showToast(`Status → ${value}`);
  }

  function dismissProposal(key) {
    setReview((prev) => prev && { ...prev, proposals: { ...prev.proposals, [key]: null } });
  }

  async function applyChangeRequest(cr, idx) {
    try {
      const res = await fetch(`/api/projects/${project.id}/apply-change-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cr),
      });
      if (res.ok) {
        showToast("Added to Notion task");
        dismissChangeRequest(idx);
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Notion append failed");
      }
    } catch (err) {
      console.error("apply change request error:", err);
      showToast("Notion append failed");
    }
  }

  function dismissChangeRequest(idx) {
    setReview((prev) =>
      prev && { ...prev, change_requests: prev.change_requests.filter((_, i) => i !== idx) }
    );
  }

  function dismissReviewEmail(id) {
    setReview((prev) =>
      prev && { ...prev, new_emails: prev.new_emails.filter((e) => e.id !== id) }
    );
  }

  async function handleIngestEmail(email) {
    setIngesting(email.id);
    try {
      const res = await fetch(`/api/projects/${project.id}/ingest-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gmail_id: email.id }),
      });
      if (res.ok) {
        const data = await res.json();
        dismissReviewEmail(email.id);
        if (data.mode === "inject") {
          showToast("Email injected into active session");
        } else {
          showToast("Ingesting — session will spawn shortly");
        }
        // Refresh inbox items after a short delay so the new item appears
        setTimeout(async () => {
          try {
            const r = await fetch(`/api/projects/${project.id}/inbox`);
            if (r.ok) setInboxItems(await r.json());
          } catch {}
        }, 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Ingest failed");
      }
    } catch (err) {
      console.error("ingest error:", err);
      showToast("Ingest failed");
    } finally {
      setIngesting(null);
    }
  }

  const div = DIVISION_COLORS[project.division] || { bg: "#6b7280", text: "#fff" };
  const INBOX_PREFIX = "Auto-created from inbox: ";
  const inboxSource = project.notes?.startsWith(INBOX_PREFIX)
    ? project.notes.slice(INBOX_PREFIX.length)
    : null;

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      {/* data-card-modal is the morph target — .modal alone would also match
          InboxModal, which shares the class. */}
      <div className={`modal${hasActiveTimer ? " modal-timer-active" : ""}`} data-card-modal>
        <div className="modal-top-actions">
          {TAGS.map((tag) => {
            const on = hasTag(project, tag.key);
            return (
              <button
                key={tag.key}
                className={`modal-tag-t${on ? " on" : ""}`}
                style={on ? { backgroundColor: tag.color, borderColor: tag.color } : {}}
                title={on ? `Tagged for ${tag.label} — click to untag` : `Tag for ${tag.label}`}
                onClick={() => onUpdate(project.id, { tags: toggleTag(project, tag.key) })}
              >
                {tag.letter}
              </button>
            );
          })}
          <button
            className={`modal-review-btn ${reviewing ? "reviewing" : ""}`}
            onClick={handleReview}
            disabled={reviewing}
            title="Check Notion, email, and recent work for proposed updates — nothing changes until you Apply"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
            </svg>
            <span>{reviewing ? "Reviewing…" : "Review"}</span>
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
          <div className="division-selector-wrap">
            {divisionOpen && (
              <div className="division-backdrop" onClick={() => setDivisionOpen(false)} />
            )}
            <span
              className="division-logo-badge clickable"
              title={project.division || "Set division"}
              onClick={() => setDivisionOpen((v) => !v)}
            >
              {project.division && DIVISION_LOGOS[project.division] ? (
                <img
                  src={DIVISION_LOGOS[project.division]}
                  alt={project.division}
                  className="division-logo"
                />
              ) : project.division ? (
                <span className="card-division" style={{ backgroundColor: div.bg, color: div.text }}>
                  {project.division}
                </span>
              ) : (
                <span className="division-unset">— division —</span>
              )}
            </span>
            {divisionOpen && (
              <div className="division-dropdown-menu">
                {Object.entries(DIVISION_LOGOS).map(([name, logo]) => (
                  <div
                    key={name}
                    className={`division-option${project.division === name ? " active" : ""}`}
                    onClick={() => {
                      setDivisionOpen(false);
                      if (name !== project.division) onUpdate(project.id, { division: name });
                    }}
                  >
                    <img src={logo} alt={name} className="division-option-logo" />
                    <span>{name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
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

        <div className="modal-tabs">
          <button className={`modal-tab${tab === "details" ? " active" : ""}`} onClick={() => setTab("details")}>
            Details
          </button>
          <button
            className={`modal-tab${tab === "terminal" ? " active" : ""}`}
            onClick={() => setTab("terminal")}
            disabled={!project.tmux_session}
            title={project.tmux_session ? undefined : "Set a tmux session to enable"}
          >
            Terminal
            {project.tmux_session && <span className="modal-tab-dot" />}
          </button>
          <button
            className={`modal-tab${tab === "spark" ? " active" : ""}`}
            onClick={() => setTab("spark")}
          >
            Spark
            {spark.status === "scanning" && <span className="modal-tab-dot modal-tab-dot-spark" />}
          </button>
        </div>

        {tab === "terminal" && <TerminalPanel project={project} hasActiveTimer={hasActiveTimer} />}

        {tab === "spark" && (
          <SparkPanel
            spark={spark}
            project={project}
            onUpdate={onUpdate}
            showToast={showToast}
            onGoToTerminal={() => setTab("terminal")}
            isAdmin={isAdmin}
          />
        )}

        {tab === "details" && <>

        {review && (
          <div className="modal-section modal-review-panel">
            <label className="modal-label">
              Review
              {review.email_lookback_days && (
                <span className="review-lookback">email: last {review.email_lookback_days}d</span>
              )}
              <button className="review-panel-close" onClick={() => setReview(null)} title="Dismiss review">×</button>
            </label>
            {review.linked_notion && (
              <div className="review-linked-note">
                Linked Notion task{review.notion_title ? `: ${review.notion_title}` : ""}
              </div>
            )}
            {review.summary && <div className="review-summary">{review.summary}</div>}

            {review.proposals?.next_step && (
              <div className="review-proposal-row">
                <div className="review-proposal-body">
                  <div className="review-proposal-label">Next step</div>
                  <div className="review-proposal-current">{nextStep || "(none)"}</div>
                  <div className="review-proposal-value">{review.proposals.next_step.value}</div>
                  <div className="review-proposal-reason">{review.proposals.next_step.reason}</div>
                </div>
                <div className="review-proposal-actions">
                  <button className="review-apply-btn" onClick={applyNextStepProposal}>Apply</button>
                  <button className="review-dismiss-btn" onClick={() => dismissProposal("next_step")}>Dismiss</button>
                </div>
              </div>
            )}

            {review.proposals?.status && (
              <div className="review-proposal-row">
                <div className="review-proposal-body">
                  <div className="review-proposal-label">Status</div>
                  <div className="review-proposal-current">{project.status}</div>
                  <div className="review-proposal-value">{review.proposals.status.value}</div>
                  <div className="review-proposal-reason">{review.proposals.status.reason}</div>
                </div>
                <div className="review-proposal-actions">
                  <button className="review-apply-btn" onClick={applyStatusProposal}>Apply</button>
                  <button className="review-dismiss-btn" onClick={() => dismissProposal("status")}>Dismiss</button>
                </div>
              </div>
            )}

            {review.change_requests?.map((cr, i) => (
              <div key={`cr-${i}`} className="review-proposal-row">
                <div className="review-proposal-body">
                  <div className="review-proposal-label">Change request</div>
                  <div className="review-proposal-value">{cr.summary}</div>
                  <div className="review-proposal-reason">{cr.detail}</div>
                </div>
                <div className="review-proposal-actions">
                  <button className="review-apply-btn" onClick={() => applyChangeRequest(cr, i)}>Add to Notion</button>
                  <button className="review-dismiss-btn" onClick={() => dismissChangeRequest(i)}>Dismiss</button>
                </div>
              </div>
            ))}

            {review.new_emails?.map((email) => {
              const from = email.from?.replace(/^"?([^"<]+)"?\s*<[^>]+>$/, "$1").trim() || email.from;
              return (
                <div key={email.id} className="review-proposal-row">
                  <div className="review-proposal-body">
                    <div className="review-proposal-label">New email</div>
                    <div className="review-proposal-value">
                      <a href={email.threadUrl} target="_blank" rel="noopener noreferrer">{email.subject || "(no subject)"}</a>
                    </div>
                    <div className="review-proposal-reason">
                      {from} · {email.date ? new Date(email.date).toLocaleDateString() : ""}
                      {email.snippet ? ` — ${email.snippet.slice(0, 120)}` : ""}
                    </div>
                  </div>
                  <div className="review-proposal-actions">
                    <button
                      className="review-apply-btn"
                      onClick={() => handleIngestEmail(email)}
                      disabled={ingesting === email.id}
                    >
                      {ingesting === email.id ? "…" : "Ingest"}
                    </button>
                    <button className="review-dismiss-btn" onClick={() => dismissReviewEmail(email.id)}>Dismiss</button>
                  </div>
                </div>
              );
            })}

            {!review.proposals?.next_step && !review.proposals?.status &&
              !review.change_requests?.length && !review.new_emails?.length && (
              <div className="review-clean">✓ Nothing new — card looks current.</div>
            )}
          </div>
        )}

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
            <div
              className="modal-value clickable"
              onClick={(e) => {
                if (e.target.tagName === "A") return;
                setEditingNotes(true);
              }}
            >
              {project.notes ? (
                <div
                  className="modal-notes-rendered"
                  dangerouslySetInnerHTML={{ __html: marked.parse(project.notes) }}
                />
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

        {(inboxLoading || inboxItems.length > 0) && (
          <div className="modal-section">
            <label className="modal-label">
              Inbox Items
              {inboxItems.length > 0 && <span className="timer-count">{inboxItems.length}</span>}
            </label>
            {inboxLoading ? (
              <div className="modal-empty">Loading…</div>
            ) : (
              <div className="modal-inbox-list">
                {inboxItems.map((item) => {
                  const dot = INBOX_STATUS_DOT[item.status] || "#94a3b8";
                  const from = item.from_addr?.replace(/^"?([^"<]+)"?\s*<[^>]+>$/, "$1").trim() || item.from_addr;
                  const canClick = !!onInboxItemClick;
                  return (
                    <div
                      key={item.id}
                      className={`modal-inbox-item${canClick ? " clickable" : ""}`}
                      onClick={() => canClick && onInboxItemClick(item)}
                    >
                      <span className="modal-inbox-dot" style={{ backgroundColor: dot }} />
                      <span className="modal-inbox-subject">{(item.subject || "(no subject)").slice(0, 60)}{(item.subject || "").length > 60 ? "…" : ""}</span>
                      <span className="modal-inbox-from">{from}</span>
                      <span className="modal-inbox-age">{relativeTime(item.created_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}
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
        </>}

        <div className="modal-footer">
          {/* Click to copy: this id is what /od-go takes to hit the card
              fast-path, so it gets transcribed by hand a lot. */}
          <button
            className="modal-id"
            onClick={() => copyText(String(project.id), `Card ID ${project.id} copied`)}
            title={`Copy card ID ${project.id} — /od-go ${project.id}`}
          >
            ID: {project.id}
          </button>
          {inboxSource && (
            <span className="modal-inbox-origin" title={inboxSource}>
              <svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" style={{ verticalAlign: "middle", marginRight: "0.25rem" }}>
                <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
                <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
              </svg>
              inbox · {inboxSource.length > 40 ? inboxSource.slice(0, 40) + "…" : inboxSource}
            </span>
          )}
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
