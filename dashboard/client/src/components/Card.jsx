import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const DIVISION_COLORS = {
  WordFlux: "#3b82f6",
  WatchThreat: "#ef4444",
  AmPen: "#8b5cf6",
  "Bedford AI": "#06b6d4",
  "ADA Web Work": "#f59e0b",
};

export default function Card({ project }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: String(project.id), data: { project } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const divColor = DIVISION_COLORS[project.division] || "#6b7280";

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="card">
      <div className="card-name">{project.name}</div>
      <div className="card-company">
        {project.company_name || "No company"}
        {project.company_short ? ` (${project.company_short})` : ""}
      </div>
      {project.division && (
        <span className="card-division" style={{ backgroundColor: divColor }}>
          {project.division}
        </span>
      )}
      {project.notes && (
        <div className="card-notes">{project.notes.slice(0, 80)}{project.notes.length > 80 ? "..." : ""}</div>
      )}
      {project.tmux_session && (
        <div className="card-tmux">{project.tmux_session}</div>
      )}
    </div>
  );
}
