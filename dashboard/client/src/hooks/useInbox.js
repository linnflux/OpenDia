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
    const interval = setInterval(fetch_, 15000);
    return () => clearInterval(interval);
  }, [fetch_]);

  function dismissItem(id) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    fetch("/api/inbox/" + id, { method: "DELETE" }).catch(() => {});
  }

  return { items, loading, refresh: fetch_, dismissItem };
}
