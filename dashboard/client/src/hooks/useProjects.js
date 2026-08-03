import { useState, useEffect, useCallback, useRef } from "react";

const COLUMNS = ["in_progress", "wfhuman", "ice", "completed"];

export function useProjects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  // Number of writes currently in flight. The 30s poll skips while this is
  // non-zero: a refetch that lands between an optimistic update and its PATCH
  // returns the pre-write server state and visibly reverts the change. Most
  // obvious with reorder, where a whole column snaps back.
  const inFlight = useRef(0);

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
    // Skip polling while the tab is backgrounded; catch up once it's visible again.
    const interval = setInterval(() => {
      if (!document.hidden && inFlight.current === 0) fetchProjects();
    }, 30000);
    function onVisibility() {
      if (!document.hidden && inFlight.current === 0) fetchProjects();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
    inFlight.current++;
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
    } finally {
      inFlight.current--;
    }
  };

  const updateProject = async (projectId, fields) => {
    // Optimistic update
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, ...fields } : p))
    );
    inFlight.current++;
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
    } finally {
      inFlight.current--;
    }
  };

  /**
   * Persist a new card order for one status column.
   *
   * `ids` must be the FULL set of ids for that status, in the desired order —
   * the server writes sort_order = 0..n-1 for exactly what it is sent, so
   * passing a filtered subset would silently rewrite the position of every
   * card the user cannot currently see. App.jsx merges the visible order back
   * into the full column before calling this.
   */
  const reorderProjects = async (status, ids) => {
    const position = new Map(ids.map((id, i) => [id, i]));
    // Optimistic: rewrite this status's cards into the new order, in place.
    // `grouped` derives from a filter over this array, so permuting the slots
    // these cards already occupy is enough — no sort needed, and cards of
    // other statuses keep their positions untouched.
    setProjects((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((p) => ({ ...p, sort_order: position.get(p.id) }));
      let i = 0;
      return prev.map((p) => (position.has(p.id) ? ordered[i++] ?? p : p));
    });
    inFlight.current++;
    try {
      const res = await fetch("/api/projects/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ids }),
      });
      if (!res.ok) throw new Error("Failed to reorder");
    } catch (err) {
      console.error("reorder error:", err);
      fetchProjects(); // Revert on failure
    } finally {
      inFlight.current--;
    }
  };

  return { grouped, projects, loading, moveProject, updateProject, reorderProjects, refresh: fetchProjects };
}
