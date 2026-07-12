import { STATUS_OPTIONS } from "../constants.js";

// Icons per status key. Colors and labels come from STATUS_OPTIONS (the
// shared source of truth) so this sidebar can't drift from the status
// colors used on cards/the modal — label is just STATUS_OPTIONS' label
// upper-cased for the sidebar's all-caps styling.
const STATUS_ICONS = {
  in_progress: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 4v3.5l2.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  wfhuman: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 13c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  ice: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M7.5 1v13M1 7.5h13M3 3l9 9M12 3l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  completed: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 7.5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

const STATUS_META = STATUS_OPTIONS.map((s) => ({
  key: s.key,
  label: s.label.toUpperCase(),
  color: s.color,
  icon: STATUS_ICONS[s.key],
}));

export default function StatusSidebar({ active, counts, onChange, mobileOpen, onMobileClose, onOpenSweep, sweepCount }) {
  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onMobileClose} />}
      <aside className={`status-sidebar${mobileOpen ? " open" : ""}`}>
        {STATUS_META.map(({ key, label, color, icon }) => (
          <button
            key={key}
            className={`status-sidebar-item${active === key ? " active" : ""}`}
            style={active === key ? { borderLeftColor: color, color } : {}}
            onClick={() => { onChange(key); onMobileClose(); }}
          >
            <span className="status-sidebar-icon">{icon}</span>
            <span className="status-sidebar-label">{label}</span>
            <span className="status-sidebar-count">{counts[key] ?? 0}</span>
          </button>
        ))}
        {onOpenSweep && (
          <>
            <div className="status-sidebar-divider" />
            <button
              className="status-sidebar-item status-sidebar-sweep"
              onClick={() => { onOpenSweep(); onMobileClose(); }}
            >
              <span className="status-sidebar-icon">
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M11 1L5.5 8.5M5.5 8.5L2 13.5h6L9 10M5.5 8.5L9 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="status-sidebar-label">SWEEP</span>
              {sweepCount > 0 && <span className="status-sidebar-count sweep-attention">{sweepCount}</span>}
            </button>
          </>
        )}
      </aside>
    </>
  );
}
