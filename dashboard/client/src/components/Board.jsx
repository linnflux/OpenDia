import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, closestCorners } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useState } from "react";
import Column from "./Column.jsx";
import Card from "./Card.jsx";

const COLUMNS = ["in_progress", "wfhuman", "ice", "completed"];

function findColumn(grouped, cardId) {
  for (const col of COLUMNS) {
    if (grouped[col].some((p) => String(p.id) === cardId)) return col;
  }
  return null;
}

export default function Board({ grouped, moveProject, reorderColumn, onCardClick, activeTimerIds }) {
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

    const activeId = active.id;
    const overId = over.id;
    const projectId = parseInt(activeId, 10);

    // Find source column
    const sourceCol = findColumn(grouped, activeId);
    if (!sourceCol) return;

    // Find target column
    let targetCol = COLUMNS.includes(overId) ? overId : findColumn(grouped, overId);
    if (!targetCol) return;

    if (sourceCol === targetCol) {
      // Within-column reorder
      const colProjects = grouped[sourceCol];
      const oldIndex = colProjects.findIndex((p) => String(p.id) === activeId);
      const overIndex = COLUMNS.includes(overId)
        ? colProjects.length - 1
        : colProjects.findIndex((p) => String(p.id) === overId);

      if (oldIndex !== overIndex && overIndex >= 0) {
        const newOrder = arrayMove(colProjects, oldIndex, overIndex);
        reorderColumn(sourceCol, newOrder.map((p) => p.id));
      }
    } else {
      // Cross-column move — move card then append to end of target column
      moveProject(projectId, targetCol);
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
          <Column key={status} status={status} projects={grouped[status] || []} onCardClick={onCardClick} activeTimerIds={activeTimerIds} />
        ))}
      </div>
      <DragOverlay>
        {activeProject ? <Card project={activeProject} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
