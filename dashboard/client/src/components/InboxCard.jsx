import { DIVISION_COLORS } from "../constants.js";

const STATUS_COLORS = {
  classified: { bg: "#1e3a5f", text: "#60a5fa", label: "Classified" },
  dispatched: { bg: "#1a3a2a", text: "#4ade80", label: "Running" },
  done:       { bg: "#1a2e1a", text: "#86efac", label: "Done" },
  error:      { bg: "#3b1a1a", text: "#f87171", label: "Error" },
  deployed:   { bg: "#1a2a3a", text: "#38bdf8", label: "Deployed" },
  "new-lead":       { bg: "#3a2f1a", text: "#fbbf24", label: "Awaiting approval" },
  "lead-approving": { bg: "#1a3a2a", text: "#4ade80", label: "Researching" },
  "lead-approved":  { bg: "#1a2e1a", text: "#86efac", label: "Approved" },
  "intake-held":    { bg: "#3a2f1a", text: "#fbbf24", label: "Held" },
  unknown_sender:   { bg: "#3b1a1a", text: "#f87171", label: "Unknown sender" },
  scaffolding:      { bg: "#1a3a2a", text: "#4ade80", label: "Scaffolding" },
  "first-draft":    { bg: "#1a2a3a", text: "#38bdf8", label: "First draft" },
};

const PRIORITY_DOT = { high: "#f87171", normal: "#94a3b8", low: "#475569" };

export default function InboxCard({ item, onClick }) {
  const div = DIVISION_COLORS[item.division_hint] || { bg: "#6b7280", text: "#fff" };
  const st = STATUS_COLORS[item.status] || STATUS_COLORS.classified;
  const dot = PRIORITY_DOT[item.priority] || PRIORITY_DOT.normal;

  const from = item.from_addr?.replace(/^"?([^"<]+)"?\s*<[^>]+>$/, "$1").trim() || item.from_addr;
  const age = relativeTime(item.created_at);

  const isServerWork = item.requires_server_access === 1 || item.requires_server_access === true;

  return (
    <div
      className={`inbox-card${item.status === "dispatched" ? " inbox-card-running" : ""}${isServerWork ? " inbox-card-server" : ""}`}
      onClick={() => onClick(item)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(item);
        }
      }}
    >
      <div className="inbox-card-top">
        <span className="inbox-card-from">{from}</span>
        <span className="inbox-card-age">{age}</span>
      </div>
      <div className="inbox-card-subject">{item.subject}</div>
      <div className="inbox-card-meta">
        <span className="inbox-priority-dot" style={{ backgroundColor: dot }} title={item.priority} />
        {isServerWork && <span className="inbox-card-server-flag">SERVER</span>}
        {item.client_hint && item.client_hint !== "unknown" && (
          <span className="inbox-card-client">{item.client_hint}</span>
        )}
        {item.division_hint && item.division_hint !== "unknown" && (
          <span className="card-division" style={{ backgroundColor: div.bg, color: div.text }}>
            {item.division_hint}
          </span>
        )}
        <span className="inbox-card-status" style={{ background: st.bg, color: st.text }}>
          {st.label}
        </span>
      </div>
      {item.short_slug && (
        <div className="inbox-card-slug">{item.short_slug.replace(/-/g, " ")}</div>
      )}
      {item.project_name && (
        <div className="inbox-card-project">{item.project_name}</div>
      )}
    </div>
  );
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
