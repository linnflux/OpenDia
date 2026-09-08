import { DIVISION_COLORS, DIVISION_WORDMARKS } from "../constants.js";
import { certitudeColor } from "./SparkPanel.jsx";

// Shared list/archive card for Runrooms and Planrooms.
//
// Layout: a brand rail on the left (division wordmark with the company mark
// stacked directly beneath it), and a body on the right — title at near full
// width with the state pill pinned top-right, meta line along the bottom.
// The ring grammar (working orbit / needs amber / finished dim) is applied by
// the caller via ringClass and styled on .room-card in App.css.

// Company mark: monogram circle + name. Deliberately shaped like AgentAvatar
// (image-with-initials-fallback) so a Notion company avatar can later replace
// the monogram by dropping an <img> in — the layout won't change.
export function CompanyMark({ company }) {
  if (!company) return null;
  const initials = company
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  return (
    <span className="company-mark" title={company}>
      <span className="company-mark-badge">{initials}</span>
      <span className="company-mark-name">{company}</span>
    </span>
  );
}

export default function RoomListCard({ ringClass, onClick, division, company, title, pct, stateClass, stateLabel, metaParts }) {
  const wordmark = DIVISION_WORDMARKS[division];
  const colors = DIVISION_COLORS[division] || { bg: "#6b7280", text: "#fff" };
  const meta = (metaParts || []).filter(Boolean);
  return (
    <button className={`room-card${ringClass || ""}`} onClick={onClick}>
      <span className="room-card-brand">
        {wordmark ? (
          <img src={wordmark} alt={division} className="room-card-mark" />
        ) : (
          <span className="runroom-division-pill" style={{ backgroundColor: colors.bg, color: colors.text }}>
            {division || "?"}
          </span>
        )}
        <CompanyMark company={company} />
      </span>
      <span className="room-card-body">
        <span className="room-card-top">
          <span className="room-card-title">
            {pct != null && (
              <span className="room-card-pct" style={{ color: certitudeColor(pct) }}>{pct}%</span>
            )}
            {title}
          </span>
          {stateLabel && <span className={`room-card-state ${stateClass || "input"}`}>{stateLabel}</span>}
        </span>
        <span className="room-card-meta">{meta.join(" · ")}</span>
      </span>
    </button>
  );
}
