// Card tags. `tags` is a comma-separated list of tag keys on the project row.
// Adding a person later = one entry here (plus nothing else).
export const TAGS = [
  { key: "tara", label: "Tara", letter: "T", color: "#f97316" },
  { key: "standing", label: "Standing", letter: "S", color: "#16a34a" },
  // A client's coordinating card: + New surfaces it and notes it in the brief.
  { key: "supervisor", label: "Supervisor", letter: "★", color: "#8b5cf6" },
];

export function hasTag(project, key) {
  return (project?.tags || "").split(",").filter(Boolean).includes(key);
}

export function toggleTag(project, key) {
  const set = new Set((project?.tags || "").split(",").filter(Boolean));
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return Array.from(set).join(",");
}
