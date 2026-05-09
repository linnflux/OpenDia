import { useState, useEffect, useMemo, useCallback } from "react";

function BoardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="3.5" height="12" rx="1" fill="currentColor" opacity="0.9" />
      <rect x="5.25" y="1" width="3.5" height="9" rx="1" fill="currentColor" opacity="0.9" />
      <rect x="9.5" y="1" width="3.5" height="11" rx="1" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 9h3l1.5 2.5h3L10 9h3V12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V9z" />
      <path d="M4 5l3 3 3-3M7 1v7" />
    </svg>
  );
}

function ClientsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="4.5" r="2" />
      <path d="M1 12c0-2.2 1.8-4 4-4s4 1.8 4 4" />
      <circle cx="10.5" cy="4.5" r="1.5" />
      <path d="M13 12c0-1.7-1.1-3.1-2.5-3.5" />
    </svg>
  );
}
import { useProjects } from "./hooks/useProjects.js";
import { useInbox } from "./hooks/useInbox.js";
import { useCompanies } from "./hooks/useCompanies.js";
import Board from "./components/Board.jsx";
import CardModal from "./components/CardModal.jsx";
import InboxCard from "./components/InboxCard.jsx";
import InboxModal from "./components/InboxModal.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import Clients from "./components/Clients.jsx";
import Analytics from "./components/Analytics.jsx";
import Billing from "./components/Billing.jsx";
import Newsletter from "./components/Newsletter.jsx";

const DIVISION_COLORS = {
  WordFlux: { bg: "#111111", text: "#ffffff", uppercase: true },
  WatchThreat: { bg: "#5e97f2", text: "#fff" },
  AmPen: { bg: "#5a7a94", text: "#fff" },
  "Bedford AI": { bg: "#f5f0e8", text: "#2b0000" },
  "ADA Web Work": { bg: "#15489f", text: "#fff" },
  Linnflux: { bg: "#54af4d", text: "#fff" },
  FluxCC: { bg: "#2d1a0e", text: "#d4a528" },
};

function getInitialTheme() {
  const saved = localStorage.getItem("opendia-theme");
  if (saved) return saved;
  return "dark";
}

export default function App() {
  const { grouped, projects, loading, moveProject, updateProject, reorderColumn, refresh } = useProjects();
  const { items: inboxItems, loading: inboxLoading, dismissItem, updateItem, redispatchItem } = useInbox();
  const companies = useCompanies(projects);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [selectedInboxItem, setSelectedInboxItem] = useState(null);
  const [pendingClientKey, setPendingClientKey] = useState(null);
  const [view, setView] = useState("board"); // "board" | "inbox" | "clients"
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const [themes, setThemes] = useState([]);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [inboxFilter, setInboxFilter] = useState("active");
  const [inboxFilterOpen, setInboxFilterOpen] = useState(false);
  const [activeTimerIds, setActiveTimerIds] = useState(new Set());
  const [me, setMe] = useState(null);

  // Derive the live project object from the current projects list so the open
  // modal automatically reflects status/next-step/notes changes pushed in by
  // the 30s poll or optimistic updates — no stale snapshot.
  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) || null
    : null;

  useEffect(() => {
    fetch("/api/themes").then((r) => r.ok ? r.json() : []).then(setThemes).catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem("opendia-theme", theme);
    fetch(`/api/theme?name=${theme}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const root = document.documentElement;
        for (const [k, v] of Object.entries(data.colors || {}))
          root.style.setProperty(`--${k}`, v);
        for (const [k, v] of Object.entries(data.radius || {}))
          root.style.setProperty(`--radius-${k}`, v);
        if (data.fonts?.sans) root.style.setProperty("--font-sans", data.fonts.sans);
        if (data.fonts?.mono) root.style.setProperty("--font-mono", data.fonts.mono);
        if (data.fonts?.["size-base"]) root.style.setProperty("--font-size-base", data.fonts["size-base"]);
      })
      .catch(() => {});
  }, [theme]);

  useEffect(() => {
    fetch("/api/me").then(r => r.ok ? r.json() : null).then(user => {
      setMe(user);
      // Snap non-admins off the billing view if they somehow land on it
      if (user && !user.is_admin && (view === "billing" || view === "newsletter")) setView("board");
    }).catch(() => {});
  }, []);

  const fetchActiveTimers = useCallback(() => {
    fetch("/api/timers/active")
      .then((r) => (r.ok ? r.json() : []))
      .then((ids) => setActiveTimerIds(new Set(ids)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchActiveTimers();
    const onFocus = () => fetchActiveTimers();
    window.addEventListener("focus", onFocus);
    // Poll every 10s so the green border appears without needing to refocus
    // the window (common when starting a timer from a terminal on the same machine).
    const interval = setInterval(fetchActiveTimers, 10000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [fetchActiveTimers]);

  // Collect unique divisions from loaded projects
  const divisions = useMemo(() => {
    const set = new Set();
    for (const list of Object.values(grouped)) {
      for (const p of list) {
        if (p.division) set.add(p.division);
      }
    }
    return Array.from(set).sort();
  }, [grouped]);

  function isInternal(project) {
    return (project.company_name || "").toLowerCase() === "linnflux";
  }

  const filtered = {};
  for (const [status, list] of Object.entries(grouped)) {
    if (filter === "all") {
      filtered[status] = list;
    } else if (filter === "deliverable") {
      filtered[status] = list.filter((p) => !isInternal(p));
    } else if (filter === "internal") {
      filtered[status] = list.filter(isInternal);
    } else {
      // Division filter
      filtered[status] = list.filter((p) => p.division === filter);
    }
  }

  // Stable-sort each column: timer-active cards bubble to top, relative order preserved within each group
  if (activeTimerIds.size > 0) {
    for (const status of Object.keys(filtered)) {
      const list = filtered[status];
      const withTimer = list.filter((p) => activeTimerIds.has(p.id));
      const without = list.filter((p) => !activeTimerIds.has(p.id));
      if (withTimer.length > 0) filtered[status] = [...withTimer, ...without];
    }
  }

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function handleCardClick(project) {
    setSelectedProjectId(project.id);
  }

  function handleModalUpdate(id, fields) {
    // updateProject does an optimistic setProjects; selectedProject is derived
    // from that list, so the modal re-renders automatically.
    updateProject(id, fields);
  }

  function handleModalClose() {
    setSelectedProjectId(null);
  }

  const pendingInbox = inboxItems.filter((i) => !["done", "dismissed"].includes(i.status)).length;

  const filteredInbox = inboxItems.filter((i) => {
    if (inboxFilter === "active") return !["done", "dismissed"].includes(i.status);
    if (inboxFilter === "done") return i.status === "done";
    return true; // "all"
  });

  function handleInboxItemClick(item) {
    // From CardModal: open InboxModal for a linked inbox item
    setSelectedInboxItem(item);
    setSelectedProjectId(null);
  }

  // Called by Ctrl+K to jump to a company in the Clients view
  function openClientPanel(companyKey) {
    setView("clients");
    setPendingClientKey(companyKey);
  }

  function handleProjectClick(projectId) {
    // From InboxModal: open CardModal for the linked project
    setSelectedProjectId(projectId);
    setSelectedInboxItem(null);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <img src="/opendia_mark.svg" alt="OpenDia" className="app-mark" />
          <h1 className="app-wordmark"><span className="wm-open">Open</span><span className="wm-dia">Dia</span></h1>
        </div>
        <nav className="view-toggle view-toggle-centered" aria-label="View">
          <button className={`view-toggle-btn${view === "board" ? " active" : ""}`} onClick={() => setView("board")}>
            <BoardIcon />
            <span>Board</span>
          </button>
          <button className={`view-toggle-btn${view === "inbox" ? " active" : ""}`} onClick={() => setView("inbox")}>
            <InboxIcon />
            <span>Inbox</span>
            {pendingInbox > 0 && <span className="inbox-badge">{pendingInbox}</span>}
          </button>
          <button className={`view-toggle-btn${view === "clients" ? " active" : ""}`} onClick={() => setView("clients")}>
            <ClientsIcon />
            <span>Clients</span>
          </button>
        </nav>

        <div className="app-header-actions">
          {view === "inbox" && (
            <div className="filter-dropdown-wrap">
              {inboxFilterOpen && <div className="filter-backdrop" onClick={() => setInboxFilterOpen(false)} />}
              <button
                className={`filter-dropdown-btn${inboxFilter !== "all" ? " active" : ""}`}
                onClick={() => setInboxFilterOpen((v) => !v)}
              >
                {inboxFilter === "all" ? "All" : inboxFilter === "active" ? "Active" : "Done"}
                <span className="filter-caret">▾</span>
              </button>
              {inboxFilterOpen && (
                <div className="filter-dropdown-menu">
                  {[
                    { key: "active", label: "Active" },
                    { key: "done", label: "Done" },
                    { key: "all", label: "All" },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      className={`filter-option${inboxFilter === key ? " active" : ""}`}
                      onClick={() => { setInboxFilter(key); setInboxFilterOpen(false); }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {view === "board" && (
            <div className="filter-dropdown-wrap">
              {filterOpen && <div className="filter-backdrop" onClick={() => setFilterOpen(false)} />}
              <button
                className={`filter-dropdown-btn${filter !== "all" ? " active" : ""}`}
                onClick={() => setFilterOpen((v) => !v)}
              >
                {filter === "all" ? "All" : (
                  <>
                    {DIVISION_COLORS[filter] && (
                      <span className="filter-dot" style={{ backgroundColor: DIVISION_COLORS[filter].bg }} />
                    )}
                    {filter === "deliverable" ? "Deliverable" : filter === "internal" ? "Internal" : filter}
                  </>
                )}
                <span className="filter-caret">▾</span>
              </button>
              {filterOpen && (
                <div className="filter-dropdown-menu">
                  {[
                    { key: "all", label: "All" },
                    { key: "deliverable", label: "Deliverable" },
                    { key: "internal", label: "Internal" },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      className={`filter-option${filter === key ? " active" : ""}`}
                      onClick={() => { setFilter(key); setFilterOpen(false); }}
                    >
                      {label}
                    </button>
                  ))}
                  {divisions.length > 0 && <div className="filter-divider" />}
                  {divisions.map((div) => {
                    const colors = DIVISION_COLORS[div] || { bg: "#6b7280", text: "#fff" };
                    const active = filter === div;
                    return (
                      <button
                        key={div}
                        className={`filter-option${active ? " active" : ""}`}
                        style={active ? { backgroundColor: colors.bg, color: colors.text } : { color: colors.bg }}
                        onClick={() => { setFilter(active ? "all" : div); setFilterOpen(false); }}
                      >
                        <span className="filter-dot" style={{ backgroundColor: colors.bg }} />
                        {div}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {me?.source === "tailscale" && (
            <span className="app-user-pill" title={me.login}>
              {me.name || me.login}
            </span>
          )}
          {themes.length > 0 && (
            <div className="theme-picker-wrap">
              {themePickerOpen && <div className="theme-picker-backdrop" onClick={() => setThemePickerOpen(false)} />}
              <button className="theme-picker-btn" onClick={() => setThemePickerOpen((o) => !o)}>
                <span className="theme-picker-dot" style={{ background: themes.find((t) => t.name === theme)?.bg }} />
                <span className="theme-picker-name">{themes.find((t) => t.name === theme)?.label ?? theme}</span>
                <span className="theme-picker-caret">▾</span>
              </button>
              {themePickerOpen && (
                <div className="theme-picker-menu">
                  {themes.map((t) => (
                    <button
                      key={t.name}
                      className={`theme-picker-option${theme === t.name ? " active" : ""}`}
                      onClick={() => { setTheme(t.name); setThemePickerOpen(false); }}
                    >
                      <span className="theme-picker-swatch" style={{ background: t.bg }} />
                      <span className="theme-picker-label">{t.label}</span>
                      {theme === t.name && <span className="theme-picker-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="cp-trigger" onClick={() => setPaletteOpen(true)}>
            <span className="cp-trigger-icon">&#x2315;</span>
            <kbd className="cp-trigger-kbd">Ctrl+K</kbd>
          </button>
        </div>
      </header>

      {view === "board" ? (
        loading ? (
          <div className="loading">Loading projects...</div>
        ) : (
          <Board grouped={filtered} moveProject={moveProject} reorderColumn={reorderColumn} onCardClick={handleCardClick} activeTimerIds={activeTimerIds} />
        )
      ) : view === "inbox" ? (
        <div className="inbox-view">
          {inboxLoading ? (
            <div className="loading">Loading inbox...</div>
          ) : filteredInbox.length === 0 ? (
            <div className="inbox-empty">{inboxItems.length === 0 ? "No inbox items. Label an email \"OpenDia Inbox\" in Gmail to get started." : "Nothing to see here."}</div>
          ) : (
            <div className="inbox-grid">
              {filteredInbox.map((item) => (
                <InboxCard key={item.id} item={item} onClick={setSelectedInboxItem} />
              ))}
            </div>
          )}
        </div>
      ) : view === "analytics" ? (
        <Analytics />
      ) : view === "billing" && me?.is_admin ? (
        <Billing />
      ) : view === "newsletter" && me?.is_admin ? (
        <Newsletter />
      ) : (
        <Clients
          projects={projects}
          pendingKey={pendingClientKey}
          onPendingConsumed={() => setPendingClientKey(null)}
          onProjectClick={handleCardClick}
        />
      )}

      {selectedProject && (
        <CardModal
          key={selectedProject.id}
          project={selectedProject}
          onClose={handleModalClose}
          onUpdate={handleModalUpdate}
          hasActiveTimer={activeTimerIds.has(selectedProject.id)}
          onInboxItemClick={handleInboxItemClick}
        />
      )}
      {selectedInboxItem && (
        <InboxModal
          item={inboxItems.find((i) => i.id === selectedInboxItem.id) || selectedInboxItem}
          onClose={() => setSelectedInboxItem(null)}
          onDismiss={dismissItem}
          onUpdate={updateItem}
          onRedispatch={redispatchItem}
          onProjectClick={handleProjectClick}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRefresh={refresh}
        projects={projects}
        companies={companies}
        onSelectProject={(p) => setSelectedProjectId(p.id)}
        onSelectCompany={(key) => { setPaletteOpen(false); openClientPanel(key); }}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onOpenAnalytics={() => { setPaletteOpen(false); setView("analytics"); }}
        isAdmin={!!me?.is_admin}
        onOpenBilling={() => { setPaletteOpen(false); setView("billing"); }}
        onOpenNewsletter={() => { setPaletteOpen(false); setView("newsletter"); }}
      />
    </div>
  );
}
