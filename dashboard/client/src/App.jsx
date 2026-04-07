import { useState, useEffect } from "react";
import { useProjects } from "./hooks/useProjects.js";
import Board from "./components/Board.jsx";
import CardModal from "./components/CardModal.jsx";
import CommandPalette from "./components/CommandPalette.jsx";

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

  function isInternal(project) {
    return (project.company_name || "").toLowerCase() === "linnflux";
  }

  const filtered = {};
  for (const [status, projects] of Object.entries(grouped)) {
    if (filter === "all") {
      filtered[status] = projects;
    } else if (filter === "deliverable") {
      filtered[status] = projects.filter((p) => !isInternal(p));
    } else {
      filtered[status] = projects.filter(isInternal);
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
          <select
            className="filter-select"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="deliverable">Deliverable</option>
            <option value="internal">Internal</option>
          </select>
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
