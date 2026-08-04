import { useState, useEffect, useMemo, useCallback } from "react";
import { useProjects } from "./hooks/useProjects.js";
import { useInbox } from "./hooks/useInbox.js";
import { useCompanies } from "./hooks/useCompanies.js";
import NavSidebar from "./components/NavSidebar.jsx";
import StatusFilterBar from "./components/StatusFilterBar.jsx";
import StatusGrid from "./components/StatusGrid.jsx";
import CardModal from "./components/CardModal.jsx";
import InboxCard from "./components/InboxCard.jsx";
import InboxModal from "./components/InboxModal.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import ThemeModal from "./components/ThemeModal.jsx";
import Clients from "./components/Clients.jsx";
import Analytics from "./components/Analytics.jsx";
import Billing from "./components/Billing.jsx";
import Newsletter from "./components/Newsletter.jsx";
import Rooms from "./components/Rooms.jsx";
import Today from "./components/Today.jsx";
import Sweep from "./components/Sweep.jsx";
import { hasTag, toggleTag } from "./tags.js";
import { DIVISION_COLORS, STATUS_OPTIONS } from "./constants.js";

function getInitialTheme() {
  const saved = localStorage.getItem("opendia-theme");
  if (saved) return saved;
  return "dark";
}

function getInitialStatus() {
  const saved = localStorage.getItem("opendia.activeStatus");
  const valid = ["in_progress", "wfhuman", "ice", "completed"];
  return valid.includes(saved) ? saved : "in_progress";
}

function getInitialCollapsed() {
  return localStorage.getItem("opendia.sidebarCollapsed") === "1";
}

export default function App() {
  const { grouped, projects, loading, moveProject, updateProject, reorderProjects, refresh } = useProjects();
  const { items: inboxItems, loading: inboxLoading, dismissItem, updateItem, redispatchItem } = useInbox();
  const companies = useCompanies(projects);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [selectedInboxItem, setSelectedInboxItem] = useState(null);
  const [pendingClientKey, setPendingClientKey] = useState(null);
  // One of the NAV_ITEMS keys. "tara" used to live here too; it is a filter on
  // the board (tag = tara), not a destination, so it is `taraOnly` below.
  const [view, setView] = useState("board");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const [themes, setThemes] = useState([]);
  const [themeModalOpen, setThemeModalOpen] = useState(false);

  const [activeStatus, setActiveStatus] = useState(getInitialStatus);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(getInitialCollapsed);
  const [taraOnly, setTaraOnly] = useState(false);
  const [filter, setFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [inboxFilter, setInboxFilter] = useState("active");
  const [inboxFilterOpen, setInboxFilterOpen] = useState(false);
  const [activeTimerIds, setActiveTimerIds] = useState(new Set());
  const [me, setMe] = useState(null);
  const [statusToast, setStatusToast] = useState(null);

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
      if (user && !user.is_admin && (view === "billing" || view === "newsletter" || view === "rooms")) setView("board");
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
    // Skip while the tab is backgrounded; catch up once it's visible again.
    const interval = setInterval(() => {
      if (!document.hidden) fetchActiveTimers();
    }, 10000);
    function onVisibility() {
      if (!document.hidden) fetchActiveTimers();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchActiveTimers]);

  // Deep link: ?project=<id> opens that card's modal once projects load
  // (used by OpenDia calendar event links). Param is consumed then stripped.
  useEffect(() => {
    if (projects.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const pid = parseInt(params.get("project"), 10);
    if (!pid) return;
    if (projects.some((p) => p.id === pid)) setSelectedProjectId(pid);
    params.delete("project");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, [projects]);

  // Attention count for the Sweep sidebar badge: active cards past their
  // next_step date or missing a next step entirely (deduped by card).
  const sweepAttention = useMemo(() => {
    const today = new Date().toLocaleDateString("en-CA");
    const ids = new Set();
    for (const p of projects) {
      if (p.status !== "in_progress" && p.status !== "wfhuman") continue;
      const m = /^(\d{4}-\d{2}-\d{2}):/.exec(p.next_step || "");
      if (m && m[1] < today) ids.add(p.id);
      else if (!p.next_step || !p.next_step.trim()) ids.add(p.id);
    }
    return ids.size;
  }, [projects]);

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
    // Tara is a filter on the same board, not a separate view
    if (taraOnly) {
      filtered[status] = filtered[status].filter((p) => hasTag(p, "tara"));
    }
  }

  function handleToggleTag(project, tagKey = "tara") {
    updateProject(project.id, { tags: toggleTag(project, tagKey) });
  }

  /**
   * Cards with a running timer pin to the top of the column: the lowest-ranked
   * timer-active card always sits above the highest-ranked idle one. Within
   * each group the persisted order applies, so timer cards can be dragged
   * among themselves.
   *
   * This is a DISPLAY-only partition. `filtered` stays in logical (persisted)
   * order, and handleReorder maps a dragged display order back onto it, so a
   * card is never permanently promoted just for having had a timer — when the
   * timer stops it drops back to the position it actually holds.
   */
  function pinActive(list) {
    if (activeTimerIds.size === 0) return list;
    const active = list.filter((p) => activeTimerIds.has(p.id));
    if (active.length === 0 || active.length === list.length) return list;
    return [...active, ...list.filter((p) => !activeTimerIds.has(p.id))];
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

  // Shared toast. Lives at the app shell rather than inside the board branch,
  // because the command palette can fire one from any view (e.g. a background
  // upload that had to be resized).
  function showToast(message, ms = 3000) {
    setStatusToast(message);
    setTimeout(() => setStatusToast(null), ms);
  }

  function handleStatusChange(projectId, newStatus) {
    // The grid is filtered to a single status, so changing status here makes
    // the card vanish from view immediately — surface a toast so it isn't silent.
    const project = projects.find((p) => p.id === projectId);
    const label = STATUS_OPTIONS.find((s) => s.key === newStatus)?.label || newStatus;
    moveProject(projectId, newStatus);
    showToast(`${project?.name || "Card"} → ${label}`);
  }

  /**
   * Drag-and-drop reorder. `displayIds` is the new order of the cards the user
   * can actually see — a filtered subset of the column, with timer-active
   * cards pinned to the front.
   *
   * Two merges, both the same shape: walk a list and, at each slot held by a
   * member of some group, drop in the next id from that group's new order.
   *
   *  1. Un-pin. Split the dragged order into timer-active and idle, then lay
   *     those two sequences back over the logical (unpinned) visible order.
   *     A timer card dragged into the idle region therefore lands last among
   *     the timer cards rather than crossing the boundary, and dragging an
   *     idle card cannot promote it above a running timer.
   *  2. Un-filter. The endpoint writes sort_order = 0..n-1 for exactly the ids
   *     it is sent, so sending only the visible subset would silently rewrite
   *     the position of every filtered-out card. Lay the visible order back
   *     over the full column so hidden cards keep their absolute slots.
   */
  function handleReorder(displayIds) {
    const logicalVisible = (filtered[activeStatus] || []).map((p) => p.id);
    const draggedActive = displayIds.filter((id) => activeTimerIds.has(id));
    const draggedIdle = displayIds.filter((id) => !activeTimerIds.has(id));
    let a = 0, d = 0;
    const unpinned = logicalVisible.map((id) =>
      activeTimerIds.has(id) ? draggedActive[a++] : draggedIdle[d++]
    );

    const visible = new Set(unpinned);
    let i = 0;
    const merged = (grouped[activeStatus] || []).map((p) =>
      visible.has(p.id) ? unpinned[i++] : p.id
    );
    reorderProjects(activeStatus, merged);
  }

  function handleActiveStatusChange(status) {
    setActiveStatus(status);
    localStorage.setItem("opendia.activeStatus", status);
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((v) => {
      localStorage.setItem("opendia.sidebarCollapsed", v ? "0" : "1");
      return !v;
    });
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
          <button
            className="sidebar-toggle"
            onClick={toggleSidebarCollapsed}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="sidebar-hamburger"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
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
            <button
              className={`tara-chip${taraOnly ? " active" : ""}`}
              onClick={() => setTaraOnly((v) => !v)}
              title={taraOnly ? "Showing only Tara's cards" : "Show only Tara's cards"}
              aria-pressed={taraOnly}
            >
              <span className="tara-tab-t">T</span>
              <span>Tara</span>
            </button>
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
          <button className="cp-trigger" onClick={() => setPaletteOpen(true)}>
            <span className="cp-trigger-icon">&#x2315;</span>
            <kbd className="cp-trigger-kbd">Ctrl+K</kbd>
          </button>
        </div>
      </header>

      {/* The sidebar is the app's navigation, so it lives in the shell and
          renders for every view — it used to be board-only, which is why
          Sweep had to be duplicated into the header's More dropdown. */}
      <div className="app-layout">
        {/* collapsed is forced off while the mobile drawer is open — below
            900px the rail becomes a 240px drawer, and a collapsed one would
            render as a labelless icon column. */}
        <NavSidebar
          view={view}
          onChange={setView}
          collapsed={sidebarCollapsed && !sidebarOpen}
          isAdmin={!!me?.is_admin}
          badges={{ inbox: pendingInbox, sweep: sweepAttention }}
          mobileOpen={sidebarOpen}
          onMobileClose={() => setSidebarOpen(false)}
        />

        <main className="app-main">
          {view === "board" ? (
            loading ? (
              <div className="loading">Loading projects...</div>
            ) : (
              <>
                <StatusFilterBar
                  active={activeStatus}
                  counts={{
                    in_progress: filtered.in_progress?.length ?? 0,
                    wfhuman:     filtered.wfhuman?.length ?? 0,
                    ice:         filtered.ice?.length ?? 0,
                    completed:   filtered.completed?.length ?? 0,
                  }}
                  onChange={handleActiveStatusChange}
                />
                <StatusGrid
                  projects={pinActive(filtered[activeStatus] || [])}
                  onCardClick={handleCardClick}
                  activeTimerIds={activeTimerIds}
                  onStatusChange={handleStatusChange}
                  onToggleTag={handleToggleTag}
                  onReorder={handleReorder}
                />
              </>
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
          ) : view === "today" ? (
            <Today onOpenProject={handleProjectClick} />
          ) : view === "sweep" ? (
            <Sweep projects={projects} onOpenProject={handleProjectClick} isAdmin={!!me?.is_admin} />
          ) : view === "analytics" ? (
            <Analytics />
          ) : view === "billing" && me?.is_admin ? (
            <Billing />
          ) : view === "newsletter" && me?.is_admin ? (
            <Newsletter />
          ) : view === "rooms" && me?.is_admin ? (
            <Rooms />
          ) : (
            <Clients
              projects={projects}
              pendingKey={pendingClientKey}
              onPendingConsumed={() => setPendingClientKey(null)}
              onProjectClick={handleCardClick}
            />
          )}
        </main>
      </div>

      {statusToast && <div className="modal-toast status-toast">{statusToast}</div>}

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
        onOpenThemeModal={() => { setPaletteOpen(false); setThemeModalOpen(true); }}
        onNavigate={(key) => { setPaletteOpen(false); setView(key); }}
        isAdmin={!!me?.is_admin}
        onNotify={showToast}
      />
      {themeModalOpen && (
        <ThemeModal
          themes={themes}
          currentTheme={theme}
          onSelect={setTheme}
          onClose={() => setThemeModalOpen(false)}
        />
      )}
    </div>
  );
}
