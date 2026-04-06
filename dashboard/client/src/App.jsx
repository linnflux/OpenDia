import { useState } from "react";
import { useProjects } from "./hooks/useProjects.js";
import Board from "./components/Board.jsx";
import CardModal from "./components/CardModal.jsx";

export default function App() {
  const { grouped, loading, moveProject, updateProject, reorderColumn } = useProjects();
  const [selectedProject, setSelectedProject] = useState(null);

  function handleCardClick(project) {
    setSelectedProject(project);
  }

  function handleModalUpdate(id, fields) {
    updateProject(id, fields);
    // Update the selected project in place so the modal reflects changes
    setSelectedProject((prev) => (prev ? { ...prev, ...fields } : null));
  }

  function handleModalClose() {
    setSelectedProject(null);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>OpenDia</h1>
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
    </div>
  );
}
