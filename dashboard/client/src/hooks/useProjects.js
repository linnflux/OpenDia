import { useState, useEffect, useCallback } from "react";

const COLUMNS = ["in_progress", "wfhuman", "ice", "completed"];

export function useProjects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects?include_completed=true");
      if (!res.ok) throw new Error("Failed to fetch projects");
      const data = await res.json();
      setProjects(data);
    } catch (err) {
      console.error("fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 30000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  const grouped = {};
  for (const col of COLUMNS) {
    grouped[col] = projects.filter((p) => p.status === col);
  }

  const moveProject = async (projectId, newStatus) => {
    // Optimistic update
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, status: newStatus } : p))
    );
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed to update");
    } catch (err) {
      console.error("move error:", err);
      fetchProjects(); // Revert on failure
    }
  };

  const updateProject = async (projectId, fields) => {
    // Optimistic update
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, ...fields } : p))
    );
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw new Error("Failed to update");
    } catch (err) {
      console.error("update error:", err);
      fetchProjects();
    }
  };

  const reorderColumn = async (status, orderedIds) => {
    // Optimistic: reorder the projects array to match orderedIds
    setProjects((prev) => {
      const inCol = prev.filter((p) => p.status === status);
      const rest = prev.filter((p) => p.status !== status);
      const ordered = orderedIds
        .map((id) => inCol.find((p) => p.id === id))
        .filter(Boolean);
      return [...rest, ...ordered];
    });
    try {
      const res = await fetch("/api/projects/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ids: orderedIds }),
      });
      if (!res.ok) throw new Error("Failed to reorder");
    } catch (err) {
      console.error("reorder error:", err);
      fetchProjects();
    }
  };

  return { grouped, projects, loading, moveProject, updateProject, reorderColumn, refresh: fetchProjects };
}
