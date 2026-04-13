import { useState, useEffect, useMemo, useCallback } from "react";
import { useProjects } from "./hooks/useProjects.js";
import { useInbox } from "./hooks/useInbox.js";
import Board from "./components/Board.jsx";
import CardModal from "./components/CardModal.jsx";
import InboxCard from "./components/InboxCard.jsx";
import InboxModal from "./components/InboxModal.jsx";
import CommandPalette from "./components/CommandPalette.jsx";

const DIVISION_COLORS = {
  WordFlux: { bg: "#3b82f6", text: "#0a1628" },
  WatchThreat: { bg: "#5e97f2", text: "#fff" },
  AmPen: { bg: "#5a7a94", text: "#fff" },
  "Bedford AI": { bg: "#f5f0e8", text: "#2b0000" },
  "ADA Web Work": { bg: "#15489f", text: "#fff" },
  Linnflux: { bg: "#54af4d", text: "#fff" },
};

function getInitialTheme() {
  const saved = localStorage.getItem("opendia-theme");
  if (saved) return saved;
  return "dark";
}

export default function App() {
  const { grouped, projects, loading, moveProject, updateProject, reorderColumn, refresh } = useProjects();
  const { items: inboxItems, loading: inboxLoading, dismissItem, updateItem, redispatchItem } = useInbox();
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [selectedInboxItem, setSelectedInboxItem] = useState(null);
  const [view, setView] = useState("board"); // "board" | "inbox"
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const [filter, setFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [inboxFilter, setInboxFilter] = useState("active");
  const [inboxFilterOpen, setInboxFilterOpen] = useState(false);
  const [activeTimerIds, setActiveTimerIds] = useState(new Set());

  // Derive the live project object from the current projects list so the open
  // modal automatically reflects status/next-step/notes changes pushed in by
  // the 30s poll or optimistic updates — no stale snapshot.
  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) || null
    : null;

  useEffect(() => {
    document.documentElement.className = theme === "light" ? "light-theme" : "";
    localStorage.setItem("opendia-theme", theme);
  }, [theme]);

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
          {/* View toggle */}
          <div className="view-toggle">
            <button className={`view-toggle-btn${view === "board" ? " active" : ""}`} onClick={() => setView("board")}>Board</button>
            <button className={`view-toggle-btn${view === "inbox" ? " active" : ""}`} onClick={() => setView("inbox")}>
              Inbox{pendingInbox > 0 && <span className="inbox-badge">{pendingInbox}</span>}
            </button>
          </div>
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
      ) : (
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
        onSelectProject={(p) => setSelectedProjectId(p.id)}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />
    </div>
  );
}
