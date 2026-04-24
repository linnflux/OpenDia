const DIVISION_LOGOS = {
  WordFlux: "/divisions/wordflux-h.png",
  WatchThreat: "/divisions/watchthreat-h.png",
  AmPen: "/divisions/ampen.png",
  "Bedford AI": "/divisions/bedford-ai-h.png",
  "ADA Web Work": "/divisions/ada-web-work.png",
  Linnflux: "/divisions/linnflux.png",
  FluxCC: "/divisions/fluxcc.png",
};

export default function ClientCard({ company, onOpen }) {
  const { companyName, divisions, statusCounts, stalenessKey, relativeTime, nextStep } = company;

  return (
    <div className="client-card" onClick={() => onOpen(company.key)}>
      <div className="client-card-name">{companyName}</div>

      {divisions.length > 0 && (
        <div className="client-division-strip">
          {divisions.map((div) =>
            DIVISION_LOGOS[div] ? (
              <img
                key={div}
                src={DIVISION_LOGOS[div]}
                alt={div}
                title={div}
                className="client-division-logo"
              />
            ) : (
              <span key={div} className="client-division-text">{div}</span>
            )
          )}
        </div>
      )}

      <div className="client-status-pills">
        {statusCounts.in_progress > 0 && (
          <span className="client-pill client-pill-in-progress">{statusCounts.in_progress} in progress</span>
        )}
        {statusCounts.wfhuman > 0 && (
          <span className="client-pill client-pill-wfhuman">{statusCounts.wfhuman} wfh</span>
        )}
        {statusCounts.ice > 0 && (
          <span className="client-pill client-pill-ice">{statusCounts.ice} ice</span>
        )}
      </div>

      <div className="client-staleness">
        <span className={`client-staleness-dot ${stalenessKey}`} />
        <span className="client-staleness-time">{relativeTime}</span>
      </div>

      {nextStep && (
        <div className="client-next-step">
          {nextStep.slice(0, 80)}{nextStep.length > 80 ? "…" : ""}
        </div>
      )}
    </div>
  );
}
