import Card from "./Card.jsx";

export default function StatusGrid({ projects, onCardClick, activeTimerIds, onStatusChange, onToggleTag }) {
  if (projects.length === 0) {
    return <div className="status-grid-empty">No projects here.</div>;
  }

  return (
    <div className="status-grid">
      {projects.map((p) => (
        <Card
          key={p.id}
          project={p}
          onClick={onCardClick}
          hasActiveTimer={activeTimerIds?.has(p.id)}
          onStatusChange={onStatusChange}
          onToggleTag={onToggleTag}
        />
      ))}
    </div>
  );
}
