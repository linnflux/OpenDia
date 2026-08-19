import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { marked } from "marked";
import {
  DialogCard, Composer, ThinkingStrip, decorateMarkdown, primeAudio, playDoneChime,
} from "./runroom/shared.jsx";

// Mailroom — Phase 2 (the view), phases A+B+C: browse the primary inbox
// Gmail-style, select a thread, get an automatic roundup, converse toward an
// action. Same philosophy as Runroom.jsx: the server reads, only the
// standing `mailroom` session writes ~/OpenDia/mailroom/threads/<id>.json —
// this page polls that file through read-only routes.
//
// Unlike Runroom.jsx (one room per tmux session, picked from a list), the
// mailroom is a SINGLE standing session: many threads, one conversation.
// There is no session picker here — selecting a thread ensures the session
// exists and hands it the thread, same as clicking into a runroom.
//
// Converse-only, on purpose: nothing on this page ever proposes or creates a
// Gmail draft. `mailState.proposed_draft`/`handled` are read straight through
// from the state file (a future phase-D session may start writing them) but
// nothing here renders an approve/edit panel for them yet.

const PAGE_SIZE = 5;

function formatDate(str) {
  if (!str) return "";
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return str;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// "Name <email>" -> "Name" (falls back to the raw header if there's no name).
function fromDisplayName(fromHeader) {
  const m = /^"?([^"<]*)"?\s*<[^>]+>$/.exec((fromHeader || "").trim());
  const name = m ? m[1].trim() : "";
  return name || fromHeader || "(unknown sender)";
}

function ThreadRow({ thread, active, onClick }) {
  return (
    <button className={`mailroom-thread-row${active ? " active" : ""}`} onClick={onClick}>
      <span className="mailroom-thread-from">{fromDisplayName(thread.from)}</span>
      <span className="mailroom-thread-subject">{thread.subject}</span>
      <span className="mailroom-thread-meta">
        {thread.messageCount > 1 && <span className="mailroom-thread-count">{thread.messageCount}</span>}
        <span className="mailroom-thread-date">{formatDate(thread.date)}</span>
      </span>
    </button>
  );
}

// One message, Gmail-style: a one-line header that toggles a plain-text
// body. Body text is rendered as paragraphs, never as HTML — the server
// already stripped every message to sanitized text (gmail.js's
// getThreadFull), so there is nothing here that could inject markup.
function MessageBlock({ message, open, onToggle }) {
  const paragraphs = (message.body || "").split(/\n{2,}/).filter((p) => p.trim());
  return (
    <div className={`mailroom-message${open ? " open" : ""}`}>
      <button className="mailroom-message-head" onClick={onToggle}>
        <span className="mailroom-message-from">{fromDisplayName(message.from)}</span>
        <span className="mailroom-message-date">{formatDate(message.date)}</span>
      </button>
      {open && (
        <div className="mailroom-message-body">
          {paragraphs.length > 0
            ? paragraphs.map((p, i) => <p key={i}>{p}</p>)
            : <p className="mailroom-message-empty">(no text body)</p>}
          {message.attachments?.length > 0 && (
            <div className="mailroom-attachments">
              {message.attachments.map((a, i) => (
                <span key={i} className="mailroom-attachment-chip" title={a.mimeType}>{a.filename}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Instant deterministic facts from /context — the "current status + last
// thing we worked on" visual anchor, before the AI roundup even starts.
function FactsStrip({ context, onOpenProject }) {
  if (!context) return <div className="mailroom-facts mailroom-facts-loading">Loading card context…</div>;
  const { project, recent_time } = context;
  if (!project) {
    return <div className="mailroom-facts mailroom-facts-empty">No matching card found for this thread.</div>;
  }
  const last = recent_time?.[0];
  return (
    <div className="mailroom-facts">
      <button className="mailroom-facts-card" onClick={() => onOpenProject?.(project.id)}>
        #{project.id} {project.name}
      </button>
      <span className={`mailroom-facts-status status-${project.status}`}>{project.status}</span>
      {project.company_name && (
        <span className="mailroom-facts-company">
          {project.company_name}{project.division ? ` · ${project.division}` : ""}
        </span>
      )}
      {project.next_step && <span className="mailroom-facts-next">{project.next_step}</span>}
      {last && (
        <span className="mailroom-facts-recent">last touched {last.date} — {last.task}</span>
      )}
    </div>
  );
}

export default function Mailroom({ me, onOpenProject }) {
  const [threads, setThreads] = useState(null); // null = loading
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState(null);

  const [selected, setSelected] = useState(null); // { threadId, subject }
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [context, setContext] = useState(null);
  const [openMessages, setOpenMessages] = useState(() => new Set());

  const [mailState, setMailState] = useState(null); // /state payload
  const [session, setSession] = useState(null);      // /session payload
  const [ensuring, setEnsuring] = useState(false);
  const [ensureError, setEnsureError] = useState(null);

  // undefined = no observation yet (never chime on the first poll).
  const wasWorking = useRef(undefined);

  // Prime the completion chime on the first real gesture, same pattern as
  // Runroom.jsx's default export — this view has its own audio context since
  // it can be opened without ever visiting Runrooms.
  useEffect(() => {
    const prime = () => primeAudio();
    window.addEventListener("pointerdown", prime, { once: true });
    window.addEventListener("keydown", prime, { once: true });
    return () => {
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("keydown", prime);
    };
  }, []);

  // ── Browse: initial load + "Show more" ────────────────────────────────
  const loadThreads = useCallback((offset, append) => {
    if (append) setLoadingMore(true);
    fetch(`/api/mailroom/threads?offset=${offset}&limit=${PAGE_SIZE}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((page) => {
        setThreads((prev) => (append ? [...(prev || []), ...page.threads] : page.threads));
        setHasMore(!!page.hasMore);
        setListError(null);
      })
      .catch((e) => setListError(e.message))
      .finally(() => setLoadingMore(false));
  }, []);

  useEffect(() => { loadThreads(0, false); }, [loadThreads]);

  // ── Select a thread: fetch its body + facts, ensure the standing session,
  //    then hand it the thread — the "auto-checkup on selection" Nick asked
  //    for. Browsing must not fail just because the session couldn't be
  //    reached, so this is best-effort and reported inline, not blocking.
  async function selectThread(thread) {
    setSelected({ threadId: thread.threadId, subject: thread.subject });
    setDetail(null); setDetailError(null); setContext(null);
    setMailState(null); setOpenMessages(new Set());
    wasWorking.current = undefined;

    fetch(`/api/mailroom/threads/${encodeURIComponent(thread.threadId)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => {
        setDetail(d);
        // Gmail's own convention: the newest message starts expanded, the
        // rest collapsed.
        const last = d.messages?.[d.messages.length - 1];
        if (last) setOpenMessages(new Set([last.id]));
      })
      .catch((e) => setDetailError(e.message));

    fetch(`/api/mailroom/threads/${encodeURIComponent(thread.threadId)}/context`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setContext)
      .catch(() => setContext(null));

    setEnsuring(true); setEnsureError(null);
    try {
      const r = await fetch("/api/mailroom/session/ensure", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
      await fetch(`/api/mailroom/threads/${encodeURIComponent(thread.threadId)}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: thread.subject }),
      });
    } catch (e) {
      setEnsureError(e.message);
    } finally {
      setEnsuring(false);
    }
  }

  function toggleMessage(id) {
    setOpenMessages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ── Poll /state + /session while a thread is selected — 1.2s while the
  //    session is working, else 2.5s: the same cadence runrooms.js's
  //    RoomView uses, with `streaming` as an effect dependency so the
  //    interval is rebuilt on the working edge, not just re-read.
  const fetchMailState = useCallback(() => {
    if (!selected) return;
    fetch(`/api/mailroom/threads/${encodeURIComponent(selected.threadId)}/state`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setMailState)
      .catch(() => {});
    fetch("/api/mailroom/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        const nowWorking = !!s?.gate?.working;
        if (wasWorking.current === true && !nowWorking) playDoneChime();
        wasWorking.current = nowWorking;
        setSession(s);
      })
      .catch(() => {});
  }, [selected]);

  const streaming = !!session?.gate?.working;
  useEffect(() => {
    if (!selected) return;
    fetchMailState();
    const t = setInterval(fetchMailState, streaming ? 1200 : 2500);
    return () => clearInterval(t);
  }, [selected, streaming, fetchMailState]);

  // No `image` endpoint — the mailroom has no image channel yet; Composer's
  // attach/paste/drop affordances quietly no-op without it.
  const endpoints = useMemo(() => ({
    send: "/api/mailroom/send",
    dialog: "/api/mailroom/dialog",
  }), []);

  function acceptSuggestion(s) {
    fetch(`/api/mailroom/threads/${encodeURIComponent(selected.threadId)}/suggestion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: s.id }),
    }).catch(() => {});
  }

  const roundupHtml = useMemo(
    () => (mailState?.roundup_md ? marked.parse(mailState.roundup_md) : ""),
    [mailState?.roundup_md]
  );
  const roundupRef = useRef(null);
  useEffect(() => { decorateMarkdown(roundupRef.current); }, [roundupHtml]);

  if (threads === null) return <div className="loading">Loading mailroom…</div>;

  return (
    <div className={`mailroom-room${selected ? " has-selection" : ""}`}>
      <aside className="mailroom-nav">
        <header className="mailroom-nav-header">
          <h1 className="mailroom-nav-heading">Mailroom</h1>
        </header>
        {listError && <div className="mailroom-error">{listError}</div>}
        <div className="mailroom-thread-list">
          {threads.map((t) => (
            <ThreadRow
              key={t.threadId}
              thread={t}
              active={selected?.threadId === t.threadId}
              onClick={() => selectThread(t)}
            />
          ))}
          {threads.length === 0 && !listError && (
            <div className="mailroom-empty">Inbox clear — nothing waiting.</div>
          )}
        </div>
        {hasMore && (
          <button className="mailroom-show-more" onClick={() => loadThreads(threads.length, true)} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Show more"}
          </button>
        )}
      </aside>

      <main className="mailroom-main">
        {!selected ? (
          <div className="mailroom-pane-empty">Select a thread to open it.</div>
        ) : (
          <>
            <header className="mailroom-thread-header">
              <h2>{selected.subject || "(no subject)"}</h2>
            </header>

            <FactsStrip context={context} onOpenProject={onOpenProject} />

            {detailError && <div className="mailroom-error">Could not load thread: {detailError}</div>}
            <div className="mailroom-thread-body">
              {(detail?.messages || []).map((m) => (
                <MessageBlock key={m.id} message={m} open={openMessages.has(m.id)} onToggle={() => toggleMessage(m.id)} />
              ))}
              {!detail && !detailError && <div className="loading">Loading thread…</div>}
            </div>

            <div className="mailroom-roundup">
              {ensuring && <div className="mailroom-roundup-status">Starting the mailroom session…</div>}
              {ensureError && <div className="mailroom-error">{ensureError}</div>}
              {!mailState && !ensuring && !ensureError && (
                <div className="mailroom-roundup-status">Running the roundup…</div>
              )}
              {mailState?.roundup_md && (
                <div className="mailroom-roundup-body" ref={roundupRef} dangerouslySetInnerHTML={{ __html: roundupHtml }} />
              )}
              {mailState?.suggestions?.length > 0 && (
                <div className="mailroom-suggestions">
                  {mailState.suggestions.map((s) => (
                    <button key={s.id} className={`mailroom-suggestion kind-${s.kind}`} onClick={() => acceptSuggestion(s)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {session?.gate?.reason === "dialog-open" && session.gate.dialog && (
              <DialogCard key={session.gate.dialog.fingerprint} dialog={session.gate.dialog} endpoints={endpoints} />
            )}
            <ThinkingStrip working={session?.gate?.working} />
            <Composer gate={session?.gate} endpoints={endpoints} />
          </>
        )}
      </main>
    </div>
  );
}
