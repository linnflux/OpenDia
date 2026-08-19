import { NAV_SECTIONS } from "../constants.js";

// Nav icons. These lived inline at the top of App.jsx while the top bar owned
// navigation; they belong with the sidebar now that it does.
const NAV_ICONS = {
  board: (
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="3.5" height="12" rx="1" fill="currentColor" opacity="0.9" />
      <rect x="5.25" y="1" width="3.5" height="9" rx="1" fill="currentColor" opacity="0.9" />
      <rect x="9.5" y="1" width="3.5" height="11" rx="1" fill="currentColor" opacity="0.9" />
    </svg>
  ),
  today: (
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="2.5" width="12" height="10" rx="1.5" />
      <path d="M4.5 1v3M9.5 1v3M1 6h12" />
      <path d="M4.5 9h1.5M7.5 9H9M4.5 11.5h1.5" />
    </svg>
  ),
  inbox: (
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 9h3l1.5 2.5h3L10 9h3V12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V9z" />
      <path d="M4 5l3 3 3-3M7 1v7" />
    </svg>
  ),
  clients: (
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="4.5" r="2" />
      <path d="M1 12c0-2.2 1.8-4 4-4s4 1.8 4 4" />
      <circle cx="10.5" cy="4.5" r="1.5" />
      <path d="M13 12c0-1.7-1.1-3.1-2.5-3.5" />
    </svg>
  ),
  // A plan being walked: checklist lines with a position marker on the middle one.
  planrooms: (
    // A plan before it moves: the same list as a runroom, first item ticked.
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 3h7.5M5.5 7h7.5M5.5 11h7.5" opacity="0.55" />
      <path d="M1 3.2l1 1 1.6-1.8" />
      <circle cx="1.8" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="1.8" cy="11" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  ),
  runrooms: (
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 3h7.5M5.5 7h7.5M5.5 11h7.5" opacity="0.55" />
      <path d="M1 5.2l2.6 1.8L1 8.8z" fill="currentColor" stroke="none" />
    </svg>
  ),
  sweep: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M11 1L5.5 8.5M5.5 8.5L2 13.5h6L9 10M5.5 8.5L9 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  analytics: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 13.5h12" />
      <rect x="3" y="8" width="2.5" height="4" rx="0.5" />
      <rect x="6.75" y="4.5" width="2.5" height="7.5" rx="0.5" />
      <rect x="10.5" y="6.5" width="2.5" height="5.5" rx="0.5" />
    </svg>
  ),
  billing: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="3.5" width="12" height="8" rx="1.5" />
      <circle cx="7.5" cy="7.5" r="2" />
      <path d="M4 7.5h.01M11 7.5h.01" />
    </svg>
  ),
  newsletter: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="3" width="11" height="9" rx="1.5" />
      <path d="M12.5 6h1v4.5a1.5 1.5 0 0 1-3 0" />
      <path d="M4 5.5h5M4 8h5M4 10h3" />
    </svg>
  ),
  rooms: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13.5V2.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v11" />
      <path d="M1.5 13.5h12" />
      <circle cx="9.5" cy="8" r="0.5" fill="currentColor" />
    </svg>
  ),
  // A robot head: the ODA roster.
  agents: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="4.5" width="10" height="8" rx="1.5" />
      <path d="M7.5 4.5V2M7.5 2h.01" />
      <circle cx="5.5" cy="8" r="0.5" fill="currentColor" />
      <circle cx="9.5" cy="8" r="0.5" fill="currentColor" />
      <path d="M5.5 10.5h4" />
    </svg>
  ),
  // An envelope: the inbox-browse view.
  mailroom: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="3" width="12" height="9" rx="1.5" />
      <path d="M2 4l5.5 4.5L13 4" />
    </svg>
  ),
};

export default function NavSidebar({
  view,
  onChange,
  collapsed,
  isAdmin,
  badges = {},
  mobileOpen,
  onMobileClose,
}) {
  const sections = NAV_SECTIONS.filter((s) => !s.adminOnly || isAdmin);

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onMobileClose} />}
      <aside
        className={`nav-sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " open" : ""}`}
        aria-label="Main navigation"
      >
        {sections.map((section, si) => (
          <div className="nav-sidebar-section" key={section.title}>
            {/* Collapsed has no room for headings, so sections are separated by
                a rule instead — but never above the first one. */}
            {!collapsed && <div className="nav-sidebar-heading">{section.title}</div>}
            {collapsed && si > 0 && <div className="nav-sidebar-divider" />}
            {section.items.map(({ key, label, badge }) => {
              const count = badge ? badges[badge] ?? 0 : 0;
              return (
                <button
                  key={key}
                  className={`nav-sidebar-item${view === key ? " active" : ""}`}
                  onClick={() => { onChange(key); onMobileClose?.(); }}
                  title={collapsed ? label : undefined}
                  aria-current={view === key ? "page" : undefined}
                >
                  <span className="nav-sidebar-icon">{NAV_ICONS[key]}</span>
                  {!collapsed && <span className="nav-sidebar-label">{label}</span>}
                  {count > 0 && (
                    <span className={`nav-sidebar-count${badge === "sweep" ? " sweep-attention" : ""}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </aside>
    </>
  );
}
