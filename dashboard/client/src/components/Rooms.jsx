import { useState, useEffect, useCallback } from "react";

// Admin view over the rooms daemon (proxied through /api/rooms with
// requireAdmin). Rooms have no TTL by design — this table IS the hygiene
// mechanism, so it has to make "what's open and how do I close it" effortless.
export default function Rooms() {
  const [rooms, setRooms] = useState(null);   // null = loading
  const [error, setError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  const fetchRooms = useCallback(() => {
    fetch("/api/rooms")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => { setRooms(data); setError(null); })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    fetchRooms();
    const t = setInterval(fetchRooms, 15000);
    return () => clearInterval(t);
  }, [fetchRooms]);

  async function closeRoom(id) {
    try {
      const r = await fetch(`/api/rooms/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fetchRooms();
    } catch (e) {
      setError(e.message);
    }
  }

  // navigator.clipboard needs a secure context; the dashboard is reached over
  // Tailscale by IP, so keep the execCommand fallback (same trap as CardModal).
  function copyUrl(room) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(room.url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = room.url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedId(room.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch { /* leave the URL visible; user can select it */ }
  }

  if (error) {
    return (
      <div className="rooms-view">
        <div className="rooms-error">
          Rooms daemon unreachable ({error}). Start it with:{" "}
          <code>systemctl --user start opendia-rooms</code>
        </div>
      </div>
    );
  }
  if (rooms === null) return <div className="loading">Loading rooms...</div>;

  return (
    <div className="rooms-view">
      <div className="rooms-header">
        <h2 className="rooms-title">Open rooms</h2>
        <span className="rooms-hint">
          <code>od-room open &lt;dir&gt;</code> from any session to open one
        </span>
      </div>
      {rooms.length === 0 ? (
        <div className="rooms-empty">No open rooms.</div>
      ) : (
        <table className="rooms-table">
          <thead>
            <tr>
              <th>Name</th><th>URL</th><th>Files</th><th>Directory</th>
              <th>Opened</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id}>
                <td className="rooms-name">
                  {r.name}
                  {r.read_only && <span className="rooms-ro-badge">read-only</span>}
                </td>
                <td>
                  <button
                    className="rooms-url"
                    onClick={() => copyUrl(r)}
                    title="Click to copy"
                  >
                    {copiedId === r.id ? "copied ✓" : r.url}
                  </button>
                </td>
                <td className="rooms-count">{r.files}</td>
                <td className="rooms-dir" title={r.dir}>{r.dir}</td>
                <td className="rooms-created">
                  {new Date(r.created).toLocaleString([], {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                </td>
                <td>
                  <button className="rooms-close-btn" onClick={() => closeRoom(r.id)}>
                    Close
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
