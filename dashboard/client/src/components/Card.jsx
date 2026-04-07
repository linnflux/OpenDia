import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const DIVISION_COLORS = {
  WordFlux: { bg: "#3b82f6", text: "#0a1628" },
  WatchThreat: { bg: "#5e97f2", text: "#fff" },
  AmPen: { bg: "#5a7a94", text: "#fff" },
  "Bedford AI": { bg: "#f5f0e8", text: "#2b0000" },
  "ADA Web Work": { bg: "#15489f", text: "#fff" },
  Linnflux: { bg: "#54af4d", text: "#fff" },
};

export default function Card({ project, onClick }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: String(project.id), data: { project } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const div = DIVISION_COLORS[project.division] || { bg: "#6b7280", text: "#fff" };

  function handleClick(e) {
    // Only open modal on true click, not after a drag
    if (onClick && !isDragging) onClick(project);
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="card" onClick={handleClick}>
      <div className="card-name">{project.name}</div>
      <div className="card-company">
        {project.company_name || "No company"}
      </div>
      {project.division && (
        <span className="card-division" style={{ backgroundColor: div.bg, color: div.text }}>
          {project.division}
        </span>
      )}
      {project.next_step && (
        <div className="card-next-step">
          <span className="card-next-arrow">&rarr;</span>
          {project.next_step.slice(0, 80)}{project.next_step.length > 80 ? "..." : ""}
        </div>
      )}
      {project.tmux_session && (
        <div className="card-tmux">{project.tmux_session}</div>
      )}
    </div>
  );
}
