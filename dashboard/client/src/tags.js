// Card tags. `tags` is a comma-separated list of tag keys on the project row.
// Adding a person later = one entry here (plus nothing else).
export const TAGS = [
  { key: "tara", label: "Tara", letter: "T", color: "#f97316" },
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
