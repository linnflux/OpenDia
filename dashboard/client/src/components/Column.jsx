import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import Card from "./Card.jsx";

const COLUMN_META = {
  in_progress: { label: "In Progress", color: "#3b82f6" },
  wfhuman: { label: "WFHuman", color: "#f59e0b" },
  completed: { label: "Completed", color: "#22c55e" },
  ice: { label: "Ice", color: "#6b7280" },
};

export default function Column({ status, projects, onCardClick }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = COLUMN_META[status];
  const ids = projects.map((p) => String(p.id));

  return (
    <div
      ref={setNodeRef}
      className={`column ${isOver ? "column-over" : ""}`}
    >
      <div className="column-header" style={{ borderTopColor: meta.color }}>
        <span className="column-title">{meta.label}</span>
        <span className="column-count">{projects.length}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="column-cards">
          {projects.map((p) => (
            <Card key={p.id} project={p} onClick={onCardClick} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
