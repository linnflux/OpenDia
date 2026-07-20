import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { marked } from "marked";

function defaultRange() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${String(last).padStart(2, "0")}` };
}

function formatRange(from, to) {
  const fmt = (s) => {
    const [y, mo, d] = s.split("-");
    return `${mo}/${d}/${y}`;
  };
  return `${fmt(from)} – ${fmt(to)}`;
}

export default function Newsletter() {
  const [range, setRange] = useState(defaultRange);
  const [notes, setNotes] = useState("");
  const [list, setList] = useState([]);
  const [activeName, setActiveName] = useState(null);
  const [content, setContent] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genElapsed, setGenElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [copyOk, setCopyOk] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const loadList = useCallback(
    () => fetch("/api/newsletter/list").then((r) => r.json()).then(setList).catch(() => {}),
    []
  );

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    if (generating) {
      setGenElapsed(0);
      timerRef.current = setInterval(() => setGenElapsed((s) => s + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [generating]);

  function loadFile(name) {
    fetch(`/api/newsletter/file?name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((d) => { setActiveName(name); setContent(d.content); setError(null); })
      .catch((e) => setError(e.message));
  }

  function generate() {
    setGenerating(true);
    setError(null);
    fetch("/api/newsletter/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: range.from, to: range.to, notes }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setActiveName(d.name);
        setContent(d.content);
      })
      .catch((e) =>
        // Generation shells out to `claude -p` (30-90s). If the response is slow
        // or the proxy drops the long request, the file is still written server-
        // side — surface that rather than making it look like nothing happened.
        setError(`${e.message}. If it was still generating, the file may have been saved — check "Past newsletters" below.`)
      )
      // Always refresh the list, success or not, so a completed-but-slow
      // generation appears instead of vanishing until a manual reload.
      .finally(() => { setGenerating(false); loadList(); });
  }

  function save() {
    if (!activeName) return;
    setSaving(true);
    setSaveOk(false);
    fetch("/api/newsletter/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: activeName, content }),
    })
      .then((r) => r.json())
      .then(() => { setSaveOk(true); setTimeout(() => setSaveOk(false), 2000); })
      .catch(() => {})
      .finally(() => setSaving(false));
  }

  function copyMarkdown() {
    navigator.clipboard.writeText(content).then(() => {
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2000);
    });
  }

  const previewHtml = useMemo(() => {
    if (!content) return "";
    return marked.parse(content);
  }, [content]);

  return (
    <div className="newsletter-page">
      <div className="newsletter-top">
        <div className="newsletter-controls">
          <label className="newsletter-label">
            From
            <input
              type="date"
              className="newsletter-date-input"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </label>
          <label className="newsletter-label">
            To
            <input
              type="date"
              className="newsletter-date-input"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </label>
          <label className="newsletter-label newsletter-notes-label">
            Notes
            <textarea
              className="newsletter-notes-input"
              placeholder="Optional: extra context, themes, or items to highlight..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </label>
          <button
            className="newsletter-generate-btn"
            onClick={generate}
            disabled={generating || !range.from || !range.to}
          >
            {generating ? (
              <>
                <span className="newsletter-spinner" />
                Generating{genElapsed > 0 ? ` (${genElapsed}s)` : "…"}
              </>
            ) : (
              "Generate Newsletter"
            )}
          </button>
        </div>

        {list.length > 0 && (
          <div className="newsletter-list">
            <div className="newsletter-list-label">Past newsletters</div>
            {list.map((f) => (
              <button
                key={f.name}
                className={`newsletter-list-item${activeName === f.name ? " active" : ""}`}
                onClick={() => loadFile(f.name)}
              >
                {formatRange(f.from, f.to)}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="newsletter-error">{error}</div>}

      {(content || generating) && (
        <div className="newsletter-editor-area">
          <div className="newsletter-pane newsletter-pane-source">
            <div className="newsletter-pane-label">Markdown</div>
            <textarea
              className="newsletter-source"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={generating}
              spellCheck
            />
          </div>
          <div className="newsletter-pane newsletter-pane-preview">
            <div className="newsletter-pane-label">Preview</div>
            <div
              className="newsletter-preview"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        </div>
      )}

      {activeName && !generating && (
        <div className="newsletter-actions">
          <button className="newsletter-action-btn" onClick={save} disabled={saving}>
            {saveOk ? "Saved ✓" : saving ? "Saving…" : "Save"}
          </button>
          <button className="newsletter-action-btn newsletter-action-copy" onClick={copyMarkdown}>
            {copyOk ? "Copied ✓" : "Copy Markdown"}
          </button>
        </div>
      )}
    </div>
  );
}
