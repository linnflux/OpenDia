import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, closestCorners } from "@dnd-kit/core";
import { useState } from "react";
import Column from "./Column.jsx";
import Card from "./Card.jsx";

const COLUMNS = ["in_progress", "wfhuman", "ice", "completed"];

export default function Board({ grouped, moveProject, onCardClick }) {
  const [activeProject, setActiveProject] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  function handleDragStart(event) {
    const project = event.active.data.current?.project;
    if (project) setActiveProject(project);
  }

  function handleDragEnd(event) {
    setActiveProject(null);
    const { active, over } = event;
    if (!over) return;

    const projectId = parseInt(active.id, 10);
    // Determine target column: either the droppable column id or the column of the card we dropped over
    let targetStatus = over.id;
    if (!COLUMNS.includes(targetStatus)) {
      // Dropped over another card — find which column it belongs to
      for (const col of COLUMNS) {
        if (grouped[col].some((p) => String(p.id) === over.id)) {
          targetStatus = col;
          break;
        }
      }
    }

    const project = grouped[Object.keys(grouped).find((k) =>
      grouped[k].some((p) => p.id === projectId)
    )]?.find((p) => p.id === projectId);

    if (project && project.status !== targetStatus && COLUMNS.includes(targetStatus)) {
      moveProject(projectId, targetStatus);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="board">
        {COLUMNS.map((status) => (
          <Column key={status} status={status} projects={grouped[status] || []} onCardClick={onCardClick} />
        ))}
      </div>
      <DragOverlay>
        {activeProject ? <Card project={activeProject} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
