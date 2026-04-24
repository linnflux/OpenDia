import { useEffect } from "react";

const DIVISION_LOGOS = {
  WordFlux: "/divisions/wordflux-h.png",
  WatchThreat: "/divisions/watchthreat-h.png",
  AmPen: "/divisions/ampen.png",
  "Bedford AI": "/divisions/bedford-ai-h.png",
  "ADA Web Work": "/divisions/ada-web-work.png",
  Linnflux: "/divisions/linnflux.png",
  FluxCC: "/divisions/fluxcc.png",
};

const NOTION_BASE = "https://www.notion.so/";

const STATUS_LABELS = {
  in_progress: "In Progress",
  wfhuman: "WFH",
  ice: "Ice",
  completed: "Done",
};

function relativeTime(isoString) {
  if (!isoString) return "";
  const dt = new Date(isoString.replace(" ", "T") + "Z");
  const days = (Date.now() - dt.getTime()) / 86400000;
  if (days < 1) return "today";
  if (days < 2) return "1d ago";
  if (days < 7) return `${Math.floor(days)}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function ProjectRow({ project, onProjectClick }) {
  return (
    <button className="client-project-row" onClick={() => onProjectClick(project)}>
      <span className={`client-project-status-pill status-${project.status}`}>
        {STATUS_LABELS[project.status] || project.status}
      </span>
      <span className="client-project-info">
        <span className="client-project-name">{project.name}</span>
        {project.next_step && (
          <span className="client-project-next-step">
            {project.next_step.slice(0, 100)}{project.next_step.length > 100 ? "…" : ""}
          </span>
        )}
      </span>
      <span className="client-project-age">{relativeTime(project.updated_at)}</span>
    </button>
  );
}

export default function ClientPanel({ company, onClose, onProjectClick }) {
  const open = !!company;

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const notionUrl = company?.companyNotionId
    ? `${NOTION_BASE}${company.companyNotionId.replace(/-/g, "")}`
    : null;

  const allDivisions = company
    ? Array.from(new Set([
        ...company.openProjects.map((p) => p.division),
        ...company.completedProjects.slice(0, 5).map((p) => p.division),
      ].filter(Boolean))).sort()
    : [];

  return (
    <>
      {open && <div className="client-panel-backdrop" onClick={onClose} />}
      <div className={`client-panel${open ? " open" : ""}`}>
        {company && (
          <>
            <div className="client-panel-header">
              <div className="client-panel-header-main">
                <div className="client-panel-name">{company.companyName}</div>
                <div className="client-panel-division-strip">
                  {allDivisions.map((div) =>
                    DIVISION_LOGOS[div] ? (
                      <img key={div} src={DIVISION_LOGOS[div]} alt={div} title={div} className="client-panel-division-logo" />
                    ) : (
                      <span key={div} className="client-division-text">{div}</span>
                    )
                  )}
                </div>
                <div className="client-panel-links">
                  {notionUrl && (
                    <a href={notionUrl} target="_blank" rel="noreferrer" className="client-panel-link" onClick={(e) => e.stopPropagation()}>
                      Notion ↗
                    </a>
                  )}
                  {company.companyWebsite && (
                    <a href={`https://${company.companyWebsite.replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer" className="client-panel-link" onClick={(e) => e.stopPropagation()}>
                      Website ↗
                    </a>
                  )}
                </div>
              </div>
              <button className="client-panel-close" onClick={onClose} aria-label="Close">✕</button>
            </div>

            <div className="client-panel-body">
              <div className="client-panel-section-heading">
                Open ({company.openProjects.length})
              </div>
              {company.openProjects.length === 0 ? (
                <div className="client-panel-empty">No open projects.</div>
              ) : (
                company.openProjects.map((p) => (
                  <ProjectRow key={p.id} project={p} onProjectClick={onProjectClick} />
                ))
              )}

              {company.completedProjects.length > 0 && (
                <details className="client-completed-disclosure">
                  <summary className="client-completed-summary">
                    Completed ({company.completedProjects.length})
                  </summary>
                  <div className="client-completed-list">
                    {company.completedProjects.slice(0, 25).map((p) => (
                      <ProjectRow key={p.id} project={p} onProjectClick={onProjectClick} />
                    ))}
                    {company.completedProjects.length > 25 && (
                      <div className="client-completed-overflow">
                        +{company.completedProjects.length - 25} more — open full history in Notion
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
