import { useState, useEffect } from "react";
import { useProjects } from "./hooks/useProjects.js";
import Board from "./components/Board.jsx";
import CardModal from "./components/CardModal.jsx";
import CommandPalette from "./components/CommandPalette.jsx";

export default function App() {
  const { grouped, loading, moveProject, updateProject, reorderColumn, refresh } = useProjects();
  const [selectedProject, setSelectedProject] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

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
        <button className="cp-trigger" onClick={() => setPaletteOpen(true)}>
          <span className="cp-trigger-icon">&#x2315;</span>
          <kbd className="cp-trigger-kbd">Ctrl+K</kbd>
        </button>
      </header>
      {loading ? (
        <div className="loading">Loading projects...</div>
      ) : (
        <Board grouped={grouped} moveProject={moveProject} reorderColumn={reorderColumn} onCardClick={handleCardClick} />
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
      />
    </div>
  );
}
