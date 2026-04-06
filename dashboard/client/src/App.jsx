import { useProjects } from "./hooks/useProjects.js";
import Board from "./components/Board.jsx";

export default function App() {
  const { grouped, loading, moveProject } = useProjects();

  return (
    <div className="app">
      <header className="app-header">
        <h1>OpenDia</h1>
      </header>
      {loading ? (
        <div className="loading">Loading projects...</div>
      ) : (
        <Board grouped={grouped} moveProject={moveProject} />
      )}
    </div>
  );
}
