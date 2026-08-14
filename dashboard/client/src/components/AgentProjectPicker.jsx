import { useState, useMemo } from "react";

// Ctrl+K-style picker scoped to assigning a project card to an ODA. Same
// substring scoring as the command palette's project search.
export default function AgentProjectPicker({ projects, assignedIds, onAssign, onClose }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const candidates = useMemo(() => {
    const assigned = new Set(assignedIds);
    const pool = (projects || []).filter((p) => !assigned.has(p.id));
    const q = query.trim().toLowerCase();
    if (!q) return pool.slice(0, 8);
    const scored = [];
    for (const p of pool) {
      let score = 0;
      if ((p.tmux_session || "").toLowerCase().includes(q)) score += 4;
      if ((p.name || "").toLowerCase().includes(q)) score += 3;
      if ((p.company_name || "").toLowerCase().includes(q)) score += 2;
      if ((p.division || "").toLowerCase().includes(q)) score += 1;
      if (score > 0) scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.p);
  }, [projects, assignedIds, query]);

  function handleKeyDown(e) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, candidates.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && candidates[activeIndex]) {
      e.preventDefault();
      onAssign(candidates[activeIndex].id);
    }
  }

  return (
    <div className="modal-backdrop agents-picker-backdrop" onClick={onClose}>
      <div className="agents-picker" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="agents-picker-input"
          value={query}
          placeholder="Search cards to assign…"
          onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
          onKeyDown={handleKeyDown}
        />
        <div className="agents-picker-list">
          {candidates.length === 0 ? (
            <div className="agents-picker-empty">No matching cards.</div>
          ) : (
            candidates.map((p, i) => (
              <button
                key={p.id}
                className={`agents-picker-item${i === activeIndex ? " active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => onAssign(p.id)}
              >
                <span className="agents-picker-name">{p.name}</span>
                <span className="agents-picker-meta">
                  {p.company_short || p.company_name || "—"} · {p.division || "—"} · {p.status}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
