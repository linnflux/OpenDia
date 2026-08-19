import { useState, useEffect, useRef } from "react";
import { marked } from "marked";

// Shared building blocks between Runroom.jsx and Mailroom.jsx — both bind a
// page to a live Claude session over the same modal-gate/tmux-send/sends.log
// machinery, and both render markdown the session writes to disk. Extracted
// zero-behavior-change from Runroom.jsx (which was the only consumer before
// this split); nothing here is Runrooms-specific except the CSS class names,
// which stay `runroom-*` so the existing App.css rules keep applying.
//
// Composer and DialogCard take an `endpoints` prop rather than a `session`
// name, so a caller building `/api/mailroom/*` URLs can reuse them unchanged.

export const STATE_GLYPHS = {
  done:    { glyph: "✓", cls: "done" },
  current: { glyph: "▶", cls: "current" },
  pending: { glyph: "○", cls: "pending" },
  failed:  { glyph: "✗", cls: "failed" },
  skipped: { glyph: "↷", cls: "skipped" },
  changed: { glyph: "~", cls: "changed" },
};

export function StateGlyph({ state }) {
  const s = STATE_GLYPHS[state] || STATE_GLYPHS.pending;
  return <span className={`runroom-glyph ${s.cls}`}>{s.glyph}</span>;
}

// navigator.clipboard needs a secure context; the dashboard is reached over
// Tailscale by IP too, so keep the execCommand fallback (same trap as Rooms).
export function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    return true;
  } catch {
    return false;
  }
}

// Decorate rendered markdown in place: every fenced block gets a copy button,
// and a fence whose preceding blockquote carries the skill's `> ⚠` warning is
// styled as destructive. Call from a useEffect keyed on the html string, once
// the HTML has landed in the DOM (marked hands us a string, not nodes).
export function decorateMarkdown(root) {
  if (!root) return;
  root.querySelectorAll("blockquote").forEach((bq) => {
    if ((bq.textContent || "").includes("⚠")) bq.classList.add("runroom-danger-note");
  });
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".runroom-copy-btn")) return;
    const prev = pre.previousElementSibling;
    if (prev?.classList?.contains("runroom-danger-note")) pre.classList.add("runroom-danger");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "runroom-copy-btn";
    btn.textContent = "copy";
    btn.addEventListener("click", () => {
      if (copyText(pre.querySelector("code")?.textContent ?? pre.textContent)) {
        btn.textContent = "copied";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("copied"); }, 1500);
      }
    });
    pre.appendChild(btn);
  });
}

// ── Completion chime ───────────────────────────────────────────────────────
// A soft two-note kalimba drop (C6 → G5) when the session finishes working.
// Synthesized, not sampled: no asset in a public repo, no licensing, and the
// timbre is tunable in code. Browsers gate audio behind a user gesture, so
// the context is primed by the first pointer/key event; if it never was
// (page opened and only watched), the chime silently skips.
let audioCtx = null;
export function primeAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

export function playDoneChime() {
  if (!audioCtx || audioCtx.state !== "running") return;
  const t0 = audioCtx.currentTime;
  for (const [freq, at, dur, peak] of [[1046.5, 0, 0.5, 0.12], [784, 0.16, 0.7, 0.1]]) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.05);
  }
}

// The session's own spinner, mirrored: verb + timing meta lifted straight
// off the terminal by the gate, with Spark-style animated ellipses. Appears
// within one poll (~2.5s) of the session starting a turn — this is the
// "did my send do anything?" answer.
export function ThinkingStrip({ working }) {
  if (!working) return null;
  return (
    <div className="runroom-thinking">
      <span className="runroom-thinking-verb">{(working.verb || "Working…").replace(/…$/, "")}</span>
      <span className="runroom-thinking-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
      {working.meta && <span className="runroom-thinking-meta">{working.meta}</span>}
    </div>
  );
}

// The chat half of the room: free text straight into the bound session's
// input box. The server refuses while a dialog is up (modal gate) or while
// someone holds take-control in the Terminal tab; the composer mirrors that
// state from the gate the detail poll already carries, so it disables itself
// before a send would bounce.
export const GATE_REASONS = {
  "dialog-open": "a dialog is open in the session — answer it in the terminal first",
  "no-input-box": "the session's input box is busy (a draft may be sitting in it)",
  "terminal-held": "someone has take-control in the Terminal tab",
  "session-gone": "the tmux session is gone",
};

// Mirror of the server's firstNameOf: actor labels never use pronouns, and
// the loopback identity has no human name.
export function firstNameOf(me) {
  if (!me || me.source === "loopback") return "Human";
  const name = (me.name || "").trim();
  if (name) return name.split(/\s+/)[0];
  return (me.login || "").split("@")[0] || "Human";
}

// The payoff of the modal gate: while the session shows a dialog, the room
// shows it too — as real buttons — instead of a disabled text box. Answers
// carry the dialog's fingerprint, so a click aimed at a dialog that has since
// changed is refused rather than answering the wrong question.
//
// endpoints.dialog is the full POST URL (the caller builds it, e.g.
// `/api/runrooms/${session}/dialog` or `/api/mailroom/dialog`).
export function DialogCard({ dialog, endpoints }) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  // Once answered, collapse to a receipt instead of leaving the full option
  // list on screen until the next poll — the 0–2.5s where the room appeared
  // to still be asking a question the operator had already settled. Form
  // dialogs (multi) stay open: their keys drive a form, they don't end it.
  const [answered, setAnswered] = useState(null);
  // The short context stops at the dialog's own box rule, so a plan-approval
  // dialog arrives with buttons and none of the plan. context_full is the
  // wide scrollback capture; auto-open it exactly when the choice is an
  // approval, because that is the dialog whose content matters most.
  const planLike = dialog.options.some((o) => /approve/i.test(o.label));
  const [showFull, setShowFull] = useState(planLike);

  async function answer(choice) {
    if (busy) return;
    setBusy(true); setFlash(null);
    try {
      const r = await fetch(endpoints.dialog, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice, fingerprint: dialog.fingerprint }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setFlash({ ok: false, msg: d?.error || `HTTP ${r.status}` });
      else {
        setFlash({ ok: true, msg: "answered" });
        if (!dialog.multi) {
          const opt = dialog.options.find((o) => String(o.n) === String(choice));
          setAnswered(opt ? opt.label : choice);
        }
      }
    } catch (e) {
      setFlash({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (answered) {
    return (
      <div className="runroom-dialog answered">
        <div className="runroom-dialog-label">✓ Answered — {answered}</div>
      </div>
    );
  }

  return (
    <div className={`runroom-dialog${dialog.plan_md ? " has-plan" : ""}`}>
      <div className="runroom-dialog-label">The session is asking</div>
      {dialog.context.length > 0 && (
        <pre className="runroom-dialog-context">{dialog.context.join("\n")}</pre>
      )}
      {dialog.plan_md ? (
        // The real plan document, located on disk — the pane can only ever
        // show one viewport page of the approval dialog's scroll box.
        <div className="runroom-dialog-plan">
          <div className="runroom-dialog-plan-label">Proposed plan · {dialog.plan_file}</div>
          <div
            className="runroom-dialog-plan-body"
            dangerouslySetInnerHTML={{ __html: marked.parse(dialog.plan_md) }}
          />
        </div>
      ) : dialog.context_full?.length > 0 && (
        <>
          <button
            className="runroom-dialog-context-toggle"
            onClick={() => setShowFull((v) => !v)}
          >
            {showFull ? "▾ Hide full context" : `▸ Show what you're deciding on (${dialog.context_full.length} lines)`}
          </button>
          {showFull && (
            <pre className="runroom-dialog-context full">{dialog.context_full.join("\n")}</pre>
          )}
        </>
      )}
      <div className="runroom-dialog-options">
        {dialog.options.map((o) => (
          <button
            key={o.n}
            disabled={busy}
            // "always allow" / "don't ask again" widens standing permissions —
            // visually set apart so it is never the reflex click.
            className={`runroom-dialog-opt${/always|don't ask/i.test(o.label) ? " warn" : ""}${o.selected ? " selected" : ""}`}
            onClick={() => answer(String(o.n))}
          >
            <span className="runroom-dialog-num">{o.n}</span> {o.label}
          </button>
        ))}
      </div>
      {dialog.multi && (
        <div className="runroom-dialog-multi-hint">
          Form dialog: ↑ ↓ move the highlight, Enter toggles or selects it, ← → switch question parts — finish on Submit. (Number buttons may be inert in this shape.)
        </div>
      )}
      <div className="runroom-dialog-foot">
        {dialog.multi && (
          <>
            <button className="runroom-dialog-util" disabled={busy} onClick={() => answer("up")}>↑</button>
            <button className="runroom-dialog-util" disabled={busy} onClick={() => answer("down")}>↓</button>
            <button className="runroom-dialog-util" disabled={busy} onClick={() => answer("left")}>←</button>
            <button className="runroom-dialog-util" disabled={busy} onClick={() => answer("right")}>→</button>
            <button className="runroom-dialog-util" disabled={busy} onClick={() => answer("space")}>Space</button>
          </>
        )}
        <button className="runroom-dialog-util" disabled={busy} onClick={() => answer("enter")}>Enter</button>
        <button className="runroom-dialog-util" disabled={busy} onClick={() => answer("esc")}>Esc</button>
        {dialog.hint && <span className="runroom-dialog-hint">{dialog.hint}</span>}
        {flash && <span className={`runroom-send-flash ${flash.ok ? "ok" : "err"}`}>{flash.msg}</span>}
      </div>
    </div>
  );
}

// A small ticker of what the terminal is printing while the session works —
// something for the operator to watch go by, not a transcript. The server
// only sends it mid-turn, so it appears with the green orbit and vanishes on
// its own when the turn ends and the room's real content takes over. A few
// rows tall; scrolling up through the captured tail pins the view, back to
// the bottom re-sticks it.
export function LiveOutput({ live }) {
  const [open, setOpen] = useState(true);
  const boxRef = useRef(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [live.lines, open]);

  return (
    <div className="runroom-live">
      <button className="runroom-live-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾ Terminal" : "▸ Terminal"}
      </button>
      {open && (
        <pre
          ref={boxRef}
          className="runroom-live-body"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}
        >{live.lines.join("\n")}</pre>
      )}
    </div>
  );
}

// endpoints.send / endpoints.image are the full POST URLs the caller built
// (e.g. `/api/runrooms/${session}/send` or `/api/mailroom/send`). endpoints.
// image is OPTIONAL — a caller with no image channel (the mailroom has none
// yet) omits it, and the attach/paste/drop affordances quietly no-op rather
// than posting to a route that doesn't exist.
export function Composer({ gate, endpoints }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState(null); // {ok, msg}
  // {file, url} — a pasted or dropped image waiting to ride with the next
  // send. Attach-then-send, never send-on-paste: a screenshot almost always
  // wants a caption, and an attachment made while the gate is closed should
  // wait patiently, not fail.
  const [attachment, setAttachment] = useState(null);
  const blocked = !gate?.ok;
  const canAttach = !!endpoints.image;

  function attach(file) {
    if (!canAttach || !file || !file.type.startsWith("image/")) return;
    setAttachment((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { file, url: URL.createObjectURL(file) };
    });
  }

  function clearAttachment() {
    setAttachment((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  function onPaste(e) {
    if (!canAttach) return; // no image channel here — let a plain paste stand
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return; // plain text pastes stay ordinary
    e.preventDefault();
    attach(item.getAsFile());
  }

  async function send() {
    const body = text.trim();
    if ((!body && !attachment) || sending) return;
    setSending(true);
    setFlash(null);
    try {
      let r;
      if (attachment) {
        // Raw image body; the text rides along as the caption. Deliberately
        // NOT multipart — the server sniffs magic bytes and never needs a
        // filename or form fields.
        const q = body ? `?caption=${encodeURIComponent(body)}` : "";
        r = await fetch(`${endpoints.image}${q}`, {
          method: "POST",
          headers: { "Content-Type": attachment.file.type || "image/png" },
          body: attachment.file,
        });
      } else {
        r = await fetch(endpoints.send, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: body }),
        });
      }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFlash({ ok: false, msg: GATE_REASONS[d?.gate?.reason] || d?.error || `HTTP ${r.status}` });
      } else {
        setText("");
        clearAttachment();
        setFlash({ ok: true, msg: attachment ? "image sent — the session will Read it" : "sent — the session has it" });
        setTimeout(() => setFlash(null), 3000);
      }
    } catch (e) {
      setFlash({ ok: false, msg: e.message });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="runroom-composer-wrap"
         onDragOver={(e) => { if (canAttach && [...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) e.preventDefault(); }}
         onDrop={(e) => {
           if (!canAttach) return;
           const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
           if (f) { e.preventDefault(); attach(f); }
         }}>
      {attachment && (
        <div className="runroom-attachment">
          <img src={attachment.url} alt="pasted attachment" className="runroom-attachment-thumb" />
          <span className="runroom-attachment-meta">
            {Math.max(1, Math.round(attachment.file.size / 1024))} KB — sends with your message
          </span>
          <button className="runroom-attachment-remove" onClick={clearAttachment} title="Remove image">&times;</button>
        </div>
      )}
      <div className="runroom-composer">
        <textarea
          className="runroom-composer-input"
          rows={2}
          value={text}
          disabled={blocked || sending}
          placeholder={blocked
            ? `sending paused — ${GATE_REASONS[gate?.reason] || gate?.reason || "unavailable"}`
            : canAttach
            ? "message the session… (Enter to send · paste or drop an image)"
            : "message the session… (Enter to send)"}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="runroom-composer-side">
          <button className="runroom-send-btn" onClick={send}
                  disabled={blocked || sending || (!text.trim() && !attachment)}>
            {sending ? "…" : "Send"}
          </button>
          {flash && (
            <span className={`runroom-send-flash ${flash.ok ? "ok" : "err"}`}>{flash.msg}</span>
          )}
        </div>
      </div>
    </div>
  );
}
