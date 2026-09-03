import { useState, useEffect, useCallback } from "react";
import "./SoCal.css";

// SoCal admin view: every managed social client, their calendar past and
// future, basic Meta analytics, and careful inline edits. The sheets stay the
// source of truth — every write goes through the guarded-write bridge, and
// editing the content of an approved post drops it back to Ready by rule.

const STATUS_COLORS = {
  Draft: "#8a8f98", Ready: "#b58900", "Under Review": "#1a73e8",
  "Changes Requested": "#d33682", Approved: "#1e8e3e", Scheduled: "#2aa198",
  Published: "#4a5568", "Do Not Run": "#aaa",
};

function Chip({ status }) {
  return <span className="socal-chip" style={{ background: STATUS_COLORS[status] || "#888" }}>{status}</span>;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00" : ""));
  return isNaN(d) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function SoCal() {
  const [clients, setClients] = useState(null);
  const [selected, setSelected] = useState(null);
  const [cal, setCal] = useState(null);
  const [an, setAn] = useState(null);
  const [editing, setEditing] = useState(null); // {id, field, value}
  const [toast, setToast] = useState(null);
  const [err, setErr] = useState(null);

  const say = (t) => { setToast(t); setTimeout(() => setToast(null), 5000); };

  useEffect(() => {
    fetch("/api/socal/clients").then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setClients(d.clients)))
      .catch((e) => setErr(String(e)));
  }, []);

  const openClient = useCallback((c) => {
    setSelected(c); setCal(null); setAn(null);
    fetch(`/api/socal/${c.slug}/calendar`).then((r) => r.json())
      .then((d) => (d.error ? say(`calendar: ${d.error}`) : setCal(d)));
    fetch(`/api/socal/${c.slug}/analytics`).then((r) => r.json())
      .then((d) => (d.error ? setAn({ page: {}, fb_posts: [], ig_posts: [], error: d.error }) : setAn(d)));
  }, []);

  const saveEdit = async () => {
    const { id, field, value } = editing;
    const r = await fetch(`/api/socal/${selected.slug}/rows/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field, value }),
    });
    const out = await r.json();
    if (out.error) { say(out.error); return; }
    say(out.warning || `${id} ${field} saved`);
    setEditing(null);
    openClient(selected); // refetch (patch invalidated server cache)
  };

  if (err) return <div className="socal-wrap"><div className="socal-error">SoCal view failed: {err}</div></div>;
  if (!clients) return <div className="socal-wrap"><div className="socal-loading">Loading SoCal clients…</div></div>;

  // ---------- client list ----------
  if (!selected) {
    return (
      <div className="socal-wrap">
        <h2 className="socal-h2">SoCal clients</h2>
        <div className="socal-grid">
          {clients.map((c) => (
            <button key={c.slug} className="socal-client" onClick={() => openClient(c)}>
              <div className="socal-client-name">{c.name}</div>
              {c.error ? (
                <div className="socal-error small">sheet unreachable</div>
              ) : (
                <>
                  <div className="socal-client-line">
                    {c.next_post
                      ? <>Next: <b>{fmtDate(c.next_post.date)}</b> — {c.next_post.title} <Chip status={c.next_post.status} /></>
                      : "No upcoming posts"}
                  </div>
                  <div className="socal-client-line muted">
                    {Object.entries(c.counts || {}).map(([s, n]) => `${n} ${s}`).join(" · ") || "empty calendar"}
                  </div>
                  {c.last_published && (
                    <div className="socal-client-line muted">Last published: {fmtDate(c.last_published.date)} — {c.last_published.title}</div>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
        {toast && <div className="socal-toast">{toast}</div>}
      </div>
    );
  }

  // ---------- client detail ----------
  const rows = cal?.rows || [];
  const upcoming = rows.filter((r) => !["Published", "Do Not Run"].includes(r.Status))
    .sort((a, b) => (a["Post date"] || "").localeCompare(b["Post date"] || ""));
  const past = rows.filter((r) => r.Status === "Published")
    .sort((a, b) => (b["Published date"] || "").localeCompare(a["Published date"] || ""));

  const editable = (row, field, kind = "text") => {
    const isEditing = editing && editing.id === row.ID && editing.field === field;
    if (!isEditing) {
      return (
        <span className="socal-editable" title="Click to edit"
          onClick={() => setEditing({ id: row.ID, field, value: row[field] || "" })}>
          {field === "Post date" ? (row[field] || "set date") : (row[field] || <i>empty</i>)}
        </span>
      );
    }
    if (kind === "textarea") {
      return (
        <span className="socal-editbox">
          <textarea rows={5} value={editing.value} autoFocus
            onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
          <span className="socal-editbtns">
            <button onClick={saveEdit}>Save</button>
            <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
          </span>
        </span>
      );
    }
    return (
      <span className="socal-editbox inline">
        <input value={editing.value} autoFocus type={kind === "date" ? "date" : "text"}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(null); }} />
        <button onClick={saveEdit}>✓</button>
        <button className="ghost" onClick={() => setEditing(null)}>✕</button>
      </span>
    );
  };

  const statusPicker = (row) => (
    <select className="socal-status-select" value={row.Status}
      style={{ borderColor: STATUS_COLORS[row.Status] }}
      onChange={(e) => setEditing(null) || fetch(`/api/socal/${selected.slug}/rows/${row.ID}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: "Status", value: e.target.value }),
      }).then((r) => r.json()).then((out) => {
        say(out.error || out.warning || `${row.ID} → ${e.target.value}`);
        if (!out.error) openClient(selected);
      })}>
      {(cal?.statuses || Object.keys(STATUS_COLORS)).map((s) => <option key={s}>{s}</option>)}
    </select>
  );

  return (
    <div className="socal-wrap">
      <div className="socal-detail-head">
        <button className="socal-back" onClick={() => { setSelected(null); setEditing(null); }}>← All clients</button>
        <h2 className="socal-h2">{selected.name}</h2>
        <div className="socal-facts">
          {cal?.config?.post_weekday && <span>{cal.config.post_weekday}s · {cal.config.posts_per_month}/mo</span>}
          {an?.page?.followers != null && <span>FB {an.page.followers} followers</span>}
          {an?.page?.ig_followers != null && <span>IG {an.page.ig_followers} followers</span>}
        </div>
      </div>

      {!cal ? <div className="socal-loading">Loading calendar…</div> : (
        <>
          <h3 className="socal-h3">Upcoming ({upcoming.length})</h3>
          <table className="socal-table">
            <thead><tr><th>ID</th><th>Date</th><th>Title</th><th>Caption</th><th>Status</th></tr></thead>
            <tbody>
              {upcoming.map((r) => (
                <tr key={r.ID}>
                  <td className="mono">{r.ID}</td>
                  <td className="nowrap">{editable(r, "Post date", "date")} {r.Time && <span className="muted">{r.Time}</span>}</td>
                  <td>{editable(r, "Title")}</td>
                  <td className="socal-caption">{editable(r, "Caption", "textarea")}</td>
                  <td>{statusPicker(r)}</td>
                </tr>
              ))}
              {upcoming.length === 0 && <tr><td colSpan={5} className="muted">Nothing queued — time for a brief.</td></tr>}
            </tbody>
          </table>
          <div className="socal-editnote">
            Edits write to the sheet with guards. Changing the caption or title of an
            Approved or Scheduled post drops it back to Ready for re-approval.
          </div>

          <h3 className="socal-h3">Published ({past.length})</h3>
          <table className="socal-table">
            <thead><tr><th>ID</th><th>Published</th><th>Title</th><th>Links</th></tr></thead>
            <tbody>
              {past.map((r) => {
                const ig = /ig_permalink=(\S+)/.exec(r.Notes || "");
                return (
                  <tr key={r.ID}>
                    <td className="mono">{r.ID}</td>
                    <td className="nowrap">{fmtDate(r["Published date"])}</td>
                    <td>{r.Title}</td>
                    <td>
                      {r.Permalink && <a href={r.Permalink} target="_blank" rel="noreferrer">FB</a>}
                      {ig && <> · <a href={ig[1]} target="_blank" rel="noreferrer">IG</a></>}
                    </td>
                  </tr>
                );
              })}
              {past.length === 0 && <tr><td colSpan={4} className="muted">Nothing published yet.</td></tr>}
            </tbody>
          </table>
        </>
      )}

      <h3 className="socal-h3">Recent activity on their pages</h3>
      {!an ? <div className="socal-loading">Loading analytics…</div> : an.error ? (
        <div className="socal-error small">analytics: {an.error}</div>
      ) : (
        <div className="socal-analytics">
          <div>
            <h4>Facebook</h4>
            {(an.fb_posts || []).slice(0, 6).map((p) => (
              <div key={p.id} className="socal-anrow">
                <span className="muted nowrap">{fmtDate((p.created || "").slice(0, 10))}</span>
                <span className="socal-anmsg">{p.message || <i>photo/link post</i>}</span>
                <span className="nowrap">👍 {p.reactions ?? "–"} · 💬 {p.comments ?? "–"} · ↗ {p.shares ?? 0}</span>
                {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer">view</a>}
              </div>
            ))}
            {(an.fb_posts || []).length === 0 && <div className="muted">No posts found.</div>}
          </div>
          <div>
            <h4>Instagram</h4>
            {(an.ig_posts || []).slice(0, 6).map((p) => (
              <div key={p.id} className="socal-anrow">
                <span className="muted nowrap">{fmtDate((p.created || "").slice(0, 10))}</span>
                <span className="socal-anmsg">{p.message || <i>media post</i>}</span>
                <span className="nowrap">♥ {p.likes ?? "–"} · 💬 {p.comments ?? "–"}</span>
                {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer">view</a>}
              </div>
            ))}
            {(an.ig_posts || []).length === 0 && <div className="muted">No media found.</div>}
          </div>
        </div>
      )}

      {toast && <div className="socal-toast">{toast}</div>}
    </div>
  );
}
