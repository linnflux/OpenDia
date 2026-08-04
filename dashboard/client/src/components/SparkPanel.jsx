import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import useTypewriter from "../hooks/useTypewriter.js";

// Spark is deliberately not a terminal: sans-serif throughout, generous
// whitespace, no cursor, no fixed-width columns. The one monospace element is
// the first-action chip, because it is literally a command.

const FRONT_LABELS = {
  timers: "Work sessions",
  notion: "Notion task",
  email: "Email",
  voice: "Google Voice",
  chat: "Google Chat",
  artifacts: "Artifacts",
};

const IDLE_VERBS = [
  "Reading the card…",
  "Scanning email…",
  "Checking Google Voice relays…",
  "Reading Google Chat…",
  "Reading the Notion task…",
  "Reviewing recent work sessions…",
  "Weighing the evidence…",
  "Drafting the recommendation…",
];

function certitudeColor(pct) {
  if (pct >= 85) return "var(--timer-open)";
  if (pct >= 60) return "var(--pill-warn-color)";
  return "var(--danger, #ef4444)";
}

function certitudeBand(pct) {
  if (pct >= 85) return "Clear";
  if (pct >= 60) return "Likely";
  return "Toss-up";
}

function fmtElapsed(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function FrontGlyph({ state }) {
  if (state === "checking") return <span className="spark-front-glyph spark-front-spin" aria-hidden="true" />;
  if (state === "done") return <span className="spark-front-glyph">✓</span>;
  if (state === "skipped") return <span className="spark-front-glyph">–</span>;
  if (state === "unavailable") return <span className="spark-front-glyph">⚠</span>;
  return <span className="spark-front-glyph">○</span>;
}

function SparkFronts({ fronts, order }) {
  if (!fronts) return null;
  return (
    <ul className="spark-fronts">
      {order.map((key, i) => {
        const f = fronts[key] || { state: "pending" };
        return (
          <li
            key={key}
            className={`spark-front is-${f.state}`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <FrontGlyph state={f.state} />
            <span className="spark-front-label">{FRONT_LABELS[key] || key}</span>
            {f.detail && <span className="spark-front-detail">{f.detail}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function SparkThinking({ verb }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 2800);
    return () => clearInterval(iv);
  }, []);
  // The server's verb wins when it has one; otherwise the line keeps moving so
  // the pane never looks stalled.
  const text = verb || IDLE_VERBS[tick % IDLE_VERBS.length];
  return (
    <div className="spark-thinking">
      <span key={text} className="spark-thinking-verb">{text}</span>
      <span className="spark-dots" aria-hidden="true">
        <span className="spark-dot" /><span className="spark-dot" /><span className="spark-dot" />
      </span>
    </div>
  );
}

function SparkCertitude({ certitude }) {
  const pct = Math.max(0, Math.min(100, certitude?.pct ?? 0));
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 900);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(pct * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pct]);

  const color = certitudeColor(pct);
  return (
    <div className="spark-certitude">
      <div className="spark-certitude-head">
        <span className="spark-certitude-num" style={{ color }}>{shown}%</span>
        <span className="spark-certitude-band">{certitudeBand(pct)}</span>
      </div>
      <div className="spark-certitude-track">
        <div className="spark-certitude-fill" style={{ width: `${shown}%`, background: color }} />
      </div>
      {certitude?.reason && <p className="spark-certitude-reason">{certitude.reason}</p>}
    </div>
  );
}

function SparkWho({ rows }) {
  if (!rows?.length) return null;
  return (
    <div className="spark-who">
      {rows.map((r, i) => (
        <div className="spark-who-row" key={i}>
          <div className="spark-who-main">
            <span className="spark-who-name">{r.who}</span>
            <span className="spark-who-does">{r.does}</span>
          </div>
          {r.when && <span className="spark-who-when">{r.when}</span>}
          {r.blocked_by && <span className="spark-who-blocked">blocked by {r.blocked_by}</span>}
        </div>
      ))}
    </div>
  );
}

function SparkBody({ md, animate }) {
  const html = useMemo(() => marked.parse(md || ""), [md]);
  const { ref, done, skip } = useTypewriter({ html, animate });
  return (
    <div className="spark-body-wrap" onClick={skip} onKeyDown={skip}>
      <div ref={ref} className="modal-notes-rendered spark-body" />
      {!done && <div className="spark-skip-hint">click to skip</div>}
    </div>
  );
}

function SparkActions({ spark, showToast }) {
  const [choices, setChoices] = useState({});
  useEffect(() => { setChoices({}); }, [spark.actions]);

  if (!spark.actions?.length) return null;
  const chosen = Object.values(choices).filter((v) => v === "do").length;
  const decided = Object.keys(choices).length;

  async function run() {
    const decisions = {};
    for (const a of spark.actions) decisions[a.id] = choices[a.id] || "skip";
    const res = await spark.decide(decisions);
    if (res?.error) showToast(res.error);
  }

  return (
    <div className="spark-proposals">
      <div className="spark-proposals-label">
        Worth doing next
        <span className="spark-proposals-round">round {spark.roundsUsed + 1} of {spark.roundsMax}</span>
      </div>
      {spark.actions.map((a) => {
        const pick = choices[a.id];
        return (
          <div key={a.id} className={`spark-action${pick ? ` picked-${pick}` : ""}`}>
            <div className="spark-action-head">
              <span className="spark-action-label">{a.label}</span>
              {a.tier === 2 && <span className="spark-tier-badge">needs a second confirm</span>}
              <span className="spark-action-mins">+{a.estimated_minutes}m</span>
            </div>
            <p className="spark-action-what">{a.what}</p>
            {a.why && <p className="spark-action-why">{a.why}</p>}
            {a.preview && <code className="spark-action-preview">{a.preview}</code>}
            <div className="spark-action-buttons">
              <button
                className={`spark-btn${pick === "do" ? " spark-btn-primary" : ""}`}
                onClick={() => setChoices((c) => ({ ...c, [a.id]: "do" }))}
              >
                Do it
              </button>
              <button
                className={`spark-btn${pick === "skip" ? " spark-btn-chosen" : ""}`}
                onClick={() => setChoices((c) => ({ ...c, [a.id]: "skip" }))}
              >
                Skip
              </button>
            </div>
          </div>
        );
      })}
      <div className="spark-proposals-run">
        <button className="spark-btn spark-btn-primary" onClick={run}
                disabled={spark.busy || decided < spark.actions.length}>
          {chosen ? `Run ${chosen} approved` : "Skip all"}
        </button>
        {decided < spark.actions.length && (
          <span className="spark-proposals-hint">
            Choose for each — {spark.actions.length - decided} left
          </span>
        )}
      </div>
    </div>
  );
}

function SparkHandoffs({ handoffs }) {
  if (!handoffs?.length) return null;
  return (
    <div className="spark-handoffs">
      <div className="spark-proposals-label">For a working session</div>
      {handoffs.map((h, i) => (
        <div className="spark-handoff" key={h.id || i}>
          <span className="spark-action-label">{h.label}</span>
          <p className="spark-action-what">{h.what}</p>
        </div>
      ))}
    </div>
  );
}

function SparkDraft({ draft, spark, showToast }) {
  const [armed, setArmed] = useState(false);
  const [count, setCount] = useState(3);

  useEffect(() => {
    if (!armed) return;
    if (count <= 0) {
      spark.sendDraft(draft.id).then((r) => {
        if (r?.error) showToast(r.error);
        setArmed(false);
        setCount(3);
      });
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [armed, count, draft.id, spark, showToast]);

  return (
    <div className="spark-draft">
      <div className="spark-draft-head">
        <span className="spark-draft-title">Drafted reply</span>
        {draft.sent
          ? <span className="spark-draft-sent">sent {new Date(draft.sentAt).toLocaleTimeString()}</span>
          : <span className="spark-draft-unsent">nothing has been sent</span>}
      </div>
      <div className="spark-draft-field"><span>To</span>{draft.to}</div>
      <div className="spark-draft-field"><span>Subject</span>{draft.subject}</div>
      <pre className="spark-draft-body">{draft.body}</pre>
      {!draft.sent && (
        <div className="spark-draft-actions">
          {armed ? (
            <>
              <span className="spark-draft-arming">Sending in {count}…</span>
              <button className="spark-btn" onClick={() => { setArmed(false); setCount(3); }}>Cancel</button>
            </>
          ) : (
            <button className="spark-btn spark-btn-primary" onClick={() => setArmed(true)} disabled={spark.busy}>
              Send this email
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const LEDGER_GLYPH = {
  done: "✓", failed: "✕", blocked: "⚠", skip: "⤳",
  timer: "◷", warn: "⚠", sent: "→", handoff: "⇥",
};

function SparkLedger({ ledger }) {
  if (!ledger?.length) return null;
  return (
    <ul className="spark-ledger">
      {ledger.map((e, i) => (
        <li key={i} className={`spark-ledger-row is-${e.kind}`}>
          <span className="spark-ledger-glyph">{LEDGER_GLYPH[e.kind] || "·"}</span>
          <span>{e.text}</span>
        </li>
      ))}
    </ul>
  );
}

export default function SparkPanel({ spark, project, onUpdate, showToast, onGoToTerminal, isAdmin }) {
  const [now, setNow] = useState(Date.now());
  const running = spark.status === "scanning" || spark.status === "acting";

  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [running]);

  const elapsed = running && spark.startedAt
    ? Math.max(0, Math.round((now - spark.startedAt) / 1000))
    : spark.elapsedSec || 0;

  async function handleGo() {
    const res = await spark.start();
    if (res?.error) showToast(res.error);
  }

  function applyNextStep() {
    const value = spark.result?.proposed_next_step?.value;
    if (!value) return;
    onUpdate(project.id, { next_step: value });
    showToast("Next step applied to the card");
  }

  function copyReport() {
    const r = spark.result;
    if (!r) return;
    const text = [
      r.headline,
      "",
      `Next step (${r.certitude?.pct}% certain): ${r.next_step?.text}`,
      r.next_step?.first_action ? `First action: ${r.next_step.first_action}` : "",
      "",
      r.body_md,
    ].filter(Boolean).join("\n");
    navigator.clipboard?.writeText(text);
    showToast("Report copied");
  }

  // ── idle ────────────────────────────────────────────────────────────────
  if (spark.loading) {
    return <div className="spark-panel"><div className="spark-stage spark-idle">Loading…</div></div>;
  }

  if (spark.status === "idle") {
    const last = spark.lastRun;
    return (
      <div className="spark-panel">
        <div className="spark-stage spark-idle">
          <p className="spark-idle-copy">
            A 15-minute refresh across every message front for this card — email, Google
            Voice, Google Chat, Notion, work sessions and artifacts — ending in one next
            step and a confidence number.
          </p>
          <button className="spark-go" onClick={handleGo} disabled={spark.busy || !isAdmin}
                  title={isAdmin ? undefined : "Spark runs are admin-only"}>
            {spark.busy ? "Starting…" : "Go"}
          </button>
          {last?.result && (
            <button className="spark-last-run" onClick={spark.showLastRun}>
              <span className="spark-last-run-meta">
                Last spark {new Date(last.at).toLocaleDateString()} · {last.result.certitude?.pct}%
              </span>
              <span className="spark-last-run-headline">{last.result.headline}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── error ───────────────────────────────────────────────────────────────
  if (spark.status === "error" && !spark.result) {
    return (
      <div className="spark-panel">
        <div className="spark-stage spark-error">
          <p className="spark-error-msg">{spark.error?.message || "The Spark run failed."}</p>
          {spark.error?.raw_tail && (
            <details className="spark-error-raw">
              <summary>Run log (tail)</summary>
              <pre>{spark.error.raw_tail}</pre>
            </details>
          )}
          <button className="spark-go" onClick={handleGo} disabled={spark.busy || !isAdmin}>Try again</button>
        </div>
      </div>
    );
  }

  async function doHandoff() {
    const res = await spark.handoff();
    if (res?.error) { showToast(res.error); return; }
    showToast("Handoff brief written");
    if (project.tmux_session) onGoToTerminal();
  }

  // ── running (scan only — an act round renders under the result) ──────────
  if (spark.status === "scanning" && !spark.result) {
    return (
      <div className="spark-panel">
        <div className="spark-stage spark-running">
          <SparkThinking verb={spark.verb} />
          <SparkFronts fronts={spark.fronts} order={spark.frontOrder} />
          <div className="spark-runfoot">
            <span className={`spark-elapsed${elapsed > 900 ? " over" : ""}`}>
              {fmtElapsed(elapsed)} <span className="spark-elapsed-of">of ~15 min</span>
            </span>
            {spark.timerStarted && (
              <span className="spark-accrual">Timer {spark.accruedMinutes}m</span>
            )}
            {spark.timerNote === "existing_timer" && (
              <span className="spark-accrual">Accruing to the running timer</span>
            )}
            <button className="spark-cancel" onClick={spark.cancel} disabled={spark.busy}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // ── result ──────────────────────────────────────────────────────────────
  const r = spark.result;
  if (!r) return null;

  const frontsChecked = (r.fronts || []).filter((f) => f.state === "checked" || f.state === "done").length;
  const proposed = r.proposed_next_step?.value;
  const canApply = proposed && proposed !== project.next_step;

  return (
    <div className="spark-panel">
      <div className="spark-stage spark-result">
        <SparkCertitude certitude={r.certitude} />

        <h3 className="spark-headline">{r.headline}</h3>

        <div className="spark-nextstep">
          <div className="spark-nextstep-label">
            Next step
            {r.next_step?.owner && <span className="spark-nextstep-owner">{r.next_step.owner}</span>}
            {r.next_step?.by_when && <span className="spark-nextstep-when">by {r.next_step.by_when}</span>}
          </div>
          <p className="spark-nextstep-text">{r.next_step?.text}</p>
          {r.next_step?.first_action && (
            <button
              className="spark-nextstep-action"
              onClick={() => { navigator.clipboard?.writeText(r.next_step.first_action); showToast("Copied"); }}
              title="Copy"
            >
              {r.next_step.first_action}
            </button>
          )}
        </div>

        <SparkWho rows={r.who_does_what} />

        {r.risk && (
          <div className="spark-risk">
            <span className="spark-risk-label">Risk</span>
            <span>{r.risk}</span>
          </div>
        )}

        <SparkFronts fronts={spark.fronts} order={spark.frontOrder} />

        <SparkBody md={r.body_md} animate={spark.liveResult} />

        {spark.ballMoved && (
          <p className="spark-ballmoved"><span>Ball moved</span>{spark.ballMoved}</p>
        )}

        <SparkLedger ledger={spark.ledger} />

        {spark.status === "acting" && (
          <div className="spark-acting">
            <SparkThinking verb={spark.verb} />
          </div>
        )}

        {spark.drafts.map((d) => (
          <SparkDraft key={d.id} draft={d} spark={spark} showToast={showToast} />
        ))}

        {spark.status === "proposing" && <SparkActions spark={spark} showToast={showToast} />}
        {spark.status === "proposing" && <SparkHandoffs handoffs={spark.handoffs} />}

        {spark.accrualPaused && (
          <p className="spark-accrual-pause">
            This Spark has accrued 60 minutes. Further work belongs under a fresh timer —
            hand off to a session to continue.
          </p>
        )}

        <div className="spark-footer">
          <div className="spark-chips">
            <span className="spark-chip">{frontsChecked} of 6 fronts</span>
            {spark.elapsedSec ? <span className="spark-chip">{fmtElapsed(spark.elapsedSec)}</span> : null}
            {spark.accruedMinutes ? <span className="spark-chip">{spark.accruedMinutes}m billed</span> : null}
            {spark.costUsd != null && <span className="spark-chip">${spark.costUsd.toFixed(2)}</span>}
            {spark.model && <span className="spark-chip">{spark.model}</span>}
            {r.style_warnings?.length > 0 && (
              <span className="spark-chip spark-chip-warn" title={r.style_warnings.join("; ")}>
                style
              </span>
            )}
          </div>
          <div className="spark-actions-row">
            {canApply && (
              <button className="spark-btn spark-btn-primary" onClick={applyNextStep}>
                Apply next step
              </button>
            )}
            <button className="spark-btn" onClick={copyReport}>Copy report</button>
            {["proposing", "acting"].includes(spark.status) ? (
              <button className="spark-btn" onClick={doHandoff} disabled={spark.busy || !isAdmin}>
                Hand off to session
              </button>
            ) : (
              <button className="spark-btn" onClick={handleGo} disabled={spark.busy || !isAdmin}>Run again</button>
            )}
            {project.tmux_session && (
              <button className="spark-btn" onClick={onGoToTerminal}>Discuss in Terminal</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
