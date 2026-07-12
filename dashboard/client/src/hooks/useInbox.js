import { useState, useEffect, useCallback } from "react";

export function useInbox() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(() => {
    fetch("/api/inbox")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { setItems(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch_();
    // Skip polling while the tab is backgrounded; catch up once it's visible again.
    const interval = setInterval(() => {
      if (!document.hidden) fetch_();
    }, 15000);
    function onVisibility() {
      if (!document.hidden) fetch_();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetch_]);

  function dismissItem(id) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    fetch("/api/inbox/" + id, { method: "DELETE" }).catch(() => {});
  }

  function updateItem(id, fields) {
    // Optimistic update
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, ...fields } : i));
    return fetch("/api/inbox/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }).then((r) => {
      if (!r.ok) {
        // Revert on failure
        fetch_();
        throw new Error("Update failed");
      }
      return r.json();
    });
  }

  function redispatchItem(id) {
    // Optimistic: mark as dispatched
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, status: "dispatched" } : i));
    return fetch(`/api/inbox/${id}/redispatch`, { method: "POST" }).then((r) => {
      if (!r.ok) {
        fetch_();
        throw new Error("Redispatch failed");
      }
      // Refresh after a short delay to pick up the new session_name written by the Python script
      setTimeout(fetch_, 3000);
      return r.json();
    });
  }

  return { items, loading, refresh: fetch_, dismissItem, updateItem, redispatchItem };
}
