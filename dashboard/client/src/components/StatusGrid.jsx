import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import Card from "./Card.jsx";

export default function StatusGrid({ projects, onCardClick, activeTimerIds, onStatusChange, onToggleTag, onReorder }) {
  const [activeId, setActiveId] = useState(null);
  // Order held locally from the moment of the drop until the parent's state
  // catches up, so the grid never flashes back to the old order in between.
  const [dragOrder, setDragOrder] = useState(null);

  const sensors = useSensors(
    // 6px of travel before a drag begins, so a plain click still opens the
    // card modal and the nested status/tag buttons stay clickable.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (projects.length === 0) {
    return <div className="status-grid-empty">No projects here.</div>;
  }

  // Drop the local override as soon as the parent reflects it, so filter and
  // poll updates aren't held behind a stale drag order.
  const parentIds = projects.map((p) => p.id);
  const stale = dragOrder && (dragOrder.length !== parentIds.length
    || dragOrder.some((id) => !parentIds.includes(id))
    || dragOrder.every((id, i) => parentIds[i] === id));
  const order = stale ? null : dragOrder;

  const list = order
    ? order.map((id) => projects.find((p) => p.id === id)).filter(Boolean)
    : projects;
  const ids = list.map((p) => p.id);
  const activeProject = activeId ? projects.find((p) => p.id === activeId) : null;

  function handleDragEnd({ active, over }) {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(active.id);
    const to = ids.indexOf(over.id);
    if (from === -1 || to === -1) return;
    const next = arrayMove(ids, from, to);
    setDragOrder(next);
    onReorder?.(next);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={({ active }) => setActiveId(active.id)}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div className="status-grid">
          {list.map((p) => (
            <Card
              key={p.id}
              project={p}
              onClick={onCardClick}
              hasActiveTimer={activeTimerIds?.has(p.id)}
              onStatusChange={onStatusChange}
              onToggleTag={onToggleTag}
              sortable
            />
          ))}
        </div>
      </SortableContext>
      {/* Rendered outside the grid so the dragged card floats at full opacity
          while its origin slot shows the gap it will drop into. */}
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
        {activeProject && (
          <div className="card card-drag-overlay">
            <div className="card-name">{activeProject.name}</div>
            <div className="card-company">{activeProject.company_name || "No company"}</div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
