import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { marked } from "marked";
import {
  DialogCard, Composer, ThinkingStrip, decorateMarkdown, primeAudio, playDoneChime, copyText,
  GATE_REASONS,
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
// One constant feeds both the refresh interval and the count chip's
// countdown-underline animation, so the two can never drift apart.
const POLL_MS = 60_000;

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

// The session's recommended reply, as a plain string in this phase (not yet
// a real Gmail draft — see the skill's "Converse-only" rule). Nick copies it
// and sends from Gmail himself; no To:/Subject synthesis here, since he's
// already looking at the thread this sits below and a wrongly-derived
// recipient on a multi-party thread would be actively misleading.
//
// onSentReport delivers the canned "reports sent or scheduled" message
// (authored server-side) and resolves to {ok, msg} for the flash — the
// session's verification verdict comes back through the state file's
// `handled` field on the next poll, not through this response.
function ProposedDraft({ text, onSentReport }) {
  const [copied, setCopied] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [flash, setFlash] = useState(null); // {ok, msg}

  function copy() {
    if (copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  async function reportSent() {
    if (reporting) return;
    setReporting(true); setFlash(null);
    const r = await onSentReport();
    setFlash(r);
    setReporting(false);
    if (r.ok) setTimeout(() => setFlash(null), 4000);
  }

  return (
    <div className="mailroom-draft">
      <div className="mailroom-draft-label">Proposed reply</div>
      <pre className="mailroom-draft-body">{text}</pre>
      <button className={`mailroom-draft-copy${copied ? " copied" : ""}`} onClick={copy}>
        {copied ? "copied" : "copy"}
      </button>
      <div className="mailroom-draft-foot">
        <button className="mailroom-draft-sent" disabled={reporting} onClick={reportSent}>
          {reporting ? "…" : "I sent it / scheduled it"}
        </button>
        {flash && <span className={`runroom-send-flash ${flash.ok ? "ok" : "err"}`}>{flash.msg}</span>}
      </div>
    </div>
  );
}

export default function Mailroom({ me, onOpenProject, onOpenPlanroom }) {
  const [threads, setThreads] = useState(null); // null = loading
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(null); // full unhandled-inbox count
  // Bumped on every non-append list load; keys the chip's countdown
  // underline so its animation restarts exactly when fresh data lands.
  const [pollEpoch, setPollEpoch] = useState(0);
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
  const [selectWaiting, setSelectWaiting] = useState(null); // gate reason, or null
  const [selectError, setSelectError] = useState(null);

  // undefined = no observation yet (never chime on the first poll).
  const wasWorking = useRef(undefined);
  // A select delivery the gate refused (409 — most commonly a fresh spawn's
  // own entry-plan approval, unrelated to any thread). Held here instead of
  // dropped so the poll loop can redeliver it the moment the gate reopens —
  // the operator's click must not silently go nowhere.
  const pendingSelectRef = useRef(null); // { threadId, subject } | null

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
  const loadThreads = useCallback((offset, append, limit = PAGE_SIZE) => {
    if (append) setLoadingMore(true);
    fetch(`/api/mailroom/threads?offset=${offset}&limit=${limit}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((page) => {
        setThreads((prev) => (append ? [...(prev || []), ...page.threads] : page.threads));
        setHasMore(!!page.hasMore);
        setTotal(typeof page.total === "number" ? page.total : null);
        // Restart the countdown on window refreshes only — "Show more" is
        // the operator paging, not a poll, and must not reset the fuse.
        if (!append) setPollEpoch((n) => n + 1);
        setListError(null);
      })
      .catch((e) => setListError(e.message))
      .finally(() => setLoadingMore(false));
  }, []);

  useEffect(() => { loadThreads(0, false); }, [loadThreads]);

  // Refresh the visible window every 60s so the count ticks — down as Nick
  // archives handled threads out of the inbox, up as new mail lands. Not a
  // cron: a component-scoped interval, torn down on unmount, so it runs
  // only while the Mailroom tab is actually open. Because the list is
  // oldest-first and stable, re-fetching the same window keeps "Show more"
  // depth and never shuffles rows under the cursor — handled threads just
  // slide out, and new arrivals (newest, so last) stay past the window.
  const listStateRef = useRef({ count: 0, busy: false });
  listStateRef.current = { count: threads?.length || 0, busy: loadingMore };
  useEffect(() => {
    const t = setInterval(() => {
      const { count, busy } = listStateRef.current;
      if (busy) return;
      // The route clamps limit at 25; cap here too so a deep "Show more"
      // window shrinks predictably rather than surprising via the server.
      loadThreads(0, false, Math.min(25, Math.max(PAGE_SIZE, count)));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadThreads]);

  // ── Select a thread: fetch its body + facts, ensure the standing session,
  //    then hand it the thread — the "auto-checkup on selection" Nick asked
  //    for. Browsing must not fail just because the session couldn't be
  //    reached, so this is best-effort and reported inline, not blocking.
  // Deliver the roundup-trigger message. The gate refuses while the session
  // is mid-turn or showing a dialog of its own (most commonly a fresh
  // spawn's entry-plan approval — unrelated to any thread, one-time per
  // spawn). That must never fail silently: hold the intent and let the poll
  // loop redeliver it the instant the gate reopens, rather than requiring
  // the operator to notice nothing happened and click again.
  async function deliverSelect(threadId, subject) {
    try {
      const r = await fetch(`/api/mailroom/threads/${encodeURIComponent(threadId)}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (d?.gate) {
          pendingSelectRef.current = { threadId, subject };
          setSelectWaiting(d.gate.reason || "busy");
          setSelectError(null);
        } else {
          setSelectWaiting(null);
          setSelectError(d?.error || `HTTP ${r.status}`);
        }
      } else {
        setSelectWaiting(null);
        setSelectError(null);
      }
    } catch (e) {
      setSelectWaiting(null);
      setSelectError(e.message);
    }
  }

  async function selectThread(thread) {
    setSelected({ threadId: thread.threadId, subject: thread.subject });
    setDetail(null); setDetailError(null); setContext(null);
    setMailState(null); setOpenMessages(new Set());
    setSelectWaiting(null); setSelectError(null);
    pendingSelectRef.current = null;
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
    } catch (e) {
      setEnsureError(e.message);
      setEnsuring(false);
      return;
    }
    setEnsuring(false);
    await deliverSelect(thread.threadId, thread.subject);
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
        // The gate just opened and a select is still waiting to go out —
        // redeliver it now. Guard on the still-selected thread in case the
        // operator moved on to a different one while this was pending.
        const pending = pendingSelectRef.current;
        if (pending && s?.gate?.ok && selected?.threadId === pending.threadId) {
          pendingSelectRef.current = null;
          deliverSelect(pending.threadId, pending.subject);
        }
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
    // "Spark the task": the Mail → Plan edge of the loop — a reply is blocked
    // on task work, so the thread hands off to the card's Planroom alongside
    // the normal delivery. The session records the acceptance in the state
    // file, and the mailroom thread deliberately stays in the list until the
    // work is done and Nick re-selects it for a fresh roundup. Falls back to
    // the card modal for a host that has no planroom navigation.
    if (s.kind === "spark" && s.card_id) (onOpenPlanroom || onOpenProject)?.(s.card_id);
  }

  async function reportSentToSession() {
    try {
      const r = await fetch(`/api/mailroom/threads/${encodeURIComponent(selected.threadId)}/sent-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: selected.subject }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, msg: GATE_REASONS[d?.gate?.reason] || d?.error || `HTTP ${r.status}` };
      return { ok: true, msg: "reported — the session is verifying" };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
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
          {typeof total === "number" && (
            <span className="mailroom-count" title="Primary-inbox threads not yet handled">
              {total} in inbox
              {/* The fuse: fills over one poll interval, holds at full while
                  the refresh is in flight, and the key remount snaps it back
                  to zero the moment fresh data lands. Pure CSS animation —
                  no timers, no per-frame JS. */}
              <span key={pollEpoch} className="mailroom-count-fuse"
                    style={{ animationDuration: `${POLL_MS}ms` }} />
            </span>
          )}
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
              {selectWaiting && (
                <div className="mailroom-roundup-status">
                  Waiting on the session ({selectWaiting}) — the roundup will start as soon as it's free.
                </div>
              )}
              {selectError && <div className="mailroom-error">Could not reach the session: {selectError}</div>}
              {!mailState && !ensuring && !ensureError && !selectWaiting && !selectError && (
                <div className="mailroom-roundup-status">Running the roundup…</div>
              )}
              {mailState?.roundup_md && (
                <div className="mailroom-roundup-body" ref={roundupRef} dangerouslySetInnerHTML={{ __html: roundupHtml }} />
              )}
              {typeof mailState?.proposed_draft === "string" && mailState.proposed_draft.trim() && (
                <ProposedDraft text={mailState.proposed_draft} onSentReport={reportSentToSession} />
              )}
              {mailState?.handled?.state && (
                <div className={`mailroom-handled state-${mailState.handled.state}`}>
                  {mailState.handled.state === "sent-verified"
                    ? `✓ Sent — verified${mailState.handled.verified_at ? ` at ${mailState.handled.verified_at}` : ""}`
                    : mailState.handled.state === "scheduled-attested"
                    ? "⏱ Scheduled — the session will re-verify"
                    : mailState.handled.state}
                  {mailState.handled.verdict && <span className="mailroom-handled-verdict"> · {mailState.handled.verdict}</span>}
                </div>
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
