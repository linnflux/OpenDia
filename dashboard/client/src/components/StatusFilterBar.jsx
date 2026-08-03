import { STATUS_OPTIONS } from "../constants.js";

// Icons per status key. Labels and colors come from STATUS_OPTIONS (the shared
// source of truth) so this bar can't drift from the status colors used on cards
// and in the modal. Moved here from StatusSidebar when the sidebar became
// navigation and the status filter moved next to the cards it filters.
const STATUS_ICONS = {
  in_progress: (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 4v3.5l2.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  wfhuman: (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 13c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  ice: (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M7.5 1v13M1 7.5h13M3 3l9 9M12 3l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  completed: (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 7.5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

export default function StatusFilterBar({ active, counts, onChange }) {
  return (
    <div className="status-filter-bar" role="tablist" aria-label="Card status">
      {STATUS_OPTIONS.map(({ key, label, color }) => (
        <button
          key={key}
          role="tab"
          aria-selected={active === key}
          className={`status-filter-pill${active === key ? " active" : ""}`}
          style={active === key ? { borderColor: color, color } : {}}
          onClick={() => onChange(key)}
        >
          <span className="status-filter-icon">{STATUS_ICONS[key]}</span>
          <span className="status-filter-label">{label}</span>
          <span className="status-filter-count">{counts[key] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
