import { useState, useEffect, useMemo } from "react";
import { useProjects } from "./hooks/useProjects.js";
import Board from "./components/Board.jsx";
import CardModal from "./components/CardModal.jsx";
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
  const [selectedProject, setSelectedProject] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    document.documentElement.className = theme === "light" ? "light-theme" : "";
    localStorage.setItem("opendia-theme", theme);
  }, [theme]);

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
    setSelectedProject(project);
  }

  function handleModalUpdate(id, fields) {
    updateProject(id, fields);
    setSelectedProject((prev) => (prev ? { ...prev, ...fields } : null));
  }

  function handleModalClose() {
    setSelectedProject(null);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <img src="/opendia_mark.svg" alt="OpenDia" className="app-mark" />
          <h1 className="app-wordmark"><span className="wm-open">Open</span><span className="wm-dia">Dia</span></h1>
        </div>
        <div className="app-header-actions">
          <div className="filter-pills">
            {["all", "deliverable", "internal"].map((key) => (
              <button
                key={key}
                className={`filter-pill ${filter === key ? "active" : ""}`}
                onClick={() => setFilter(filter === key && key !== "all" ? "all" : key)}
              >
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </button>
            ))}
            {divisions.map((div) => {
              const colors = DIVISION_COLORS[div] || { bg: "#6b7280", text: "#fff" };
              const active = filter === div;
              return (
                <button
                  key={div}
                  className={`filter-pill filter-pill-div ${active ? "active" : ""}`}
                  style={{
                    backgroundColor: active ? colors.bg : "transparent",
                    color: active ? colors.text : colors.bg,
                    borderColor: colors.bg,
                  }}
                  onClick={() => setFilter(active ? "all" : div)}
                >
                  {div}
                </button>
              );
            })}
          </div>
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? "\u2600" : "\u263D"}
          </button>
          <button className="cp-trigger" onClick={() => setPaletteOpen(true)}>
            <span className="cp-trigger-icon">&#x2315;</span>
            <kbd className="cp-trigger-kbd">Ctrl+K</kbd>
          </button>
        </div>
      </header>
      {loading ? (
        <div className="loading">Loading projects...</div>
      ) : (
        <Board grouped={filtered} moveProject={moveProject} reorderColumn={reorderColumn} onCardClick={handleCardClick} />
      )}
      {selectedProject && (
        <CardModal
          project={selectedProject}
          onClose={handleModalClose}
          onUpdate={handleModalUpdate}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRefresh={refresh}
        projects={projects}
        onSelectProject={(p) => setSelectedProject(p)}
      />
    </div>
  );
}
