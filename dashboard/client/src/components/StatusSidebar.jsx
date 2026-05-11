const STATUS_META = [
  {
    key: "in_progress",
    label: "IN PROGRESS",
    color: "#3b82f6",
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.5 4v3.5l2.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "wfhuman",
    label: "WFHUMAN",
    color: "#f59e0b",
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <circle cx="7.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M2 13c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "ice",
    label: "ICE",
    color: "#6b7280",
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <path d="M7.5 1v13M1 7.5h13M3 3l9 9M12 3l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "completed",
    label: "COMPLETED",
    color: "#22c55e",
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M4.5 7.5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function StatusSidebar({ active, counts, onChange, mobileOpen, onMobileClose }) {
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
      </aside>
    </>
  );
}
