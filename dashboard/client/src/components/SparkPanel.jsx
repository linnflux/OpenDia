import { useEffect, useState } from "react";

// Spark is deliberately not a terminal: sans-serif throughout, generous
// whitespace, no cursor, no fixed-width columns. The one monospace element is
// the first-action chip, because it is literally a command.
//
// The report reads top to bottom as one thought: how much to trust this, where
// the project stands, what has been happening, and then the single decision.
// Everything else — drafts, the run ledger, an archived run's prose report —
// sits below the decision, because it is evidence for a choice already made.

const FRONT_LABELS = {
  timers: "Work sessions",
  notion: "Notion task",
  email: "Email",
  voice: "Google Voice",
  chat: "Google Chat",
  artifacts: "Artifacts",
};

// No trailing ellipsis anywhere: the animated dots beside the line are the
// ellipsis, and a typed one next to them reads as six dots.
const IDLE_VERBS = [
  "Reading the card",
  "Scanning email",
  "Checking Google Voice relays",
  "Reading Google Chat",
  "Reading the Notion task",
  "Reviewing recent work sessions",
  "Weighing the evidence",
  "Drafting the recommendation",
];

// What the sweep bills. The idle copy, the running counter and this all read
// from one number so the panel tells one story about how long a Spark takes.
const SWEEP_MINUTES = 15;

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

function fmtDay(date) {
  if (!date) return "";
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
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
  const text = (verb || IDLE_VERBS[tick % IDLE_VERBS.length]).replace(/[.…]+$/, "");
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

// What has actually been happening, dated, newest first. This is the evidence
// the recommendation rests on — it used to be buried inside a prose report.
function SparkRecent({ recent }) {
  const items = recent || [];
  if (!items.length) return null;
  const head = items.slice(0, 6);
  const rest = items.slice(6);
  const row = (x, i) => (
    <li key={i} className="spark-recent-row">
      <span className="spark-recent-date">{fmtDay(x.date) || "—"}</span>
      {x.front && <span className="spark-recent-front">{FRONT_LABELS[x.front] || x.front}</span>}
      <span className="spark-recent-text">{x.text}</span>
    </li>
  );
  return (
    <div className="spark-recent">
      <div className="spark-section-label">Recent activity</div>
      <ul className="spark-recent-list">{head.map(row)}</ul>
      {rest.length > 0 && (
        <details className="spark-recent-more">
          <summary>{rest.length} earlier</summary>
          <ul className="spark-recent-list">{rest.map((x, i) => row(x, i + 6))}</ul>
        </details>
      )}
    </div>
  );
}

/**
 * The decision. One step, one route, three ways to answer.
 *
 * "Do it" and "Open a runroom" are mutually exclusive by construction — the
 * route decides which appears, so there is never a choice about *how* to do the
 * thing on top of the choice about *whether*. Below the certitude threshold the
 * emphasis moves to Adjust: a step Spark is not confident in is one to correct,
 * not one to point automation at.
 */
function SparkDecision({ spark, showToast, onGoToRunroom, isAdmin }) {
  const [adjusting, setAdjusting] = useState(false);
  const [note, setNote] = useState("");

  // Keyed on the run, not on the step object: a reconnect hands back a fresh
  // snapshot with new object identities, and keying on those wiped whatever the
  // operator had typed.
  useEffect(() => { setAdjusting(false); setNote(""); }, [spark.runId]);

  const step = spark.result?.next_step;
  if (!step) return null;

  const pct = spark.result?.certitude?.pct ?? 0;
  const low = pct < (spark.lowCertitude ?? 60);
  const canAct = isAdmin && !spark.busy;
  const opendia = step.route === "opendia";

  async function act(intent, text = "") {
    const res = await spark.decide(intent, text);
    if (res?.error) { showToast(res.error); return; }
    if (intent === "runroom" && res.session) {
      showToast(`Runroom open in ${res.session} · Spark timer closed`);
      onGoToRunroom?.(res.session);
    }
  }

  return (
    <div className={`spark-decision${low ? " is-lowcert" : ""}`}>
      <div className="spark-section-label">
        Next step
        {step.owner && <span className="spark-decision-owner">{step.owner}</span>}
        {step.by_when && <span className="spark-decision-when">by {step.by_when}</span>}
      </div>

      <p className="spark-decision-text">{step.text}</p>
      {step.why && <p className="spark-decision-why">{step.why}</p>}

      <p className="spark-decision-cert" style={{ color: certitudeColor(pct) }}>
        {pct}% certain
        {spark.result?.certitude?.reason && (
          <span className="spark-decision-cert-reason"> — {spark.result.certitude.reason}</span>
        )}
      </p>

      {step.first_action && (
        <button
          className="spark-decision-action"
          onClick={() => { navigator.clipboard?.writeText(step.first_action); showToast("Copied"); }}
          title="Copy"
        >
          {step.first_action}
        </button>
      )}

      {low && (
        <p className="spark-decision-lowcert">
          Under {spark.lowCertitude ?? 60}% the evidence did not hold up. Correcting the
          recommendation is usually the better move than acting on it.
        </p>
      )}

      {adjusting ? (
        <div className="spark-adjust">
          <textarea
            className="spark-adjust-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            autoFocus
            placeholder="What is wrong with this, or what should happen instead? This outranks the recommendation."
          />
          <div className="spark-decision-buttons">
            <button
              className="spark-btn spark-btn-primary"
              onClick={() => act("adjust", note.trim())}
              disabled={!canAct || !note.trim()}
            >
              Send the correction
            </button>
            <button className="spark-btn" onClick={() => setAdjusting(false)} disabled={spark.busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="spark-decision-buttons">
          {opendia ? (
            <button
              className={`spark-btn${low ? "" : " spark-btn-primary"}`}
              onClick={() => act("do")}
              disabled={!canAct}
              title={isAdmin ? "OpenDia carries this out and bills it to this card's timer" : "Spark runs are admin-only"}
            >
              Do it
              {step.estimated_minutes ? <span className="spark-btn-mins">+{step.estimated_minutes}m</span> : null}
            </button>
          ) : (
            <button
              className={`spark-btn${low ? "" : " spark-btn-primary"}`}
              onClick={() => act("runroom")}
              disabled={!canAct}
              title={isAdmin ? "Seeds a plan, opens a working session, and closes this Spark's timer" : "Spark runs are admin-only"}
            >
              Open a runroom
              {step.estimated_minutes ? <span className="spark-btn-mins">~{step.estimated_minutes}m</span> : null}
            </button>
          )}
          <button
            className={`spark-btn${low ? " spark-btn-primary" : ""}`}
            onClick={() => setAdjusting(true)}
            disabled={!canAct}
          >
            Adjust
          </button>
          <button className="spark-btn spark-btn-quiet" onClick={() => act("stop")} disabled={!canAct}>
            Not now
          </button>
        </div>
      )}

      {spark.roundsUsed > 0 && (
        <p className="spark-decision-round">round {spark.roundsUsed} of {spark.roundsMax}</p>
      )}
    </div>
  );
}

// Spark's outbound responsibility ends at the draft. The draft is already
// sitting in Gmail — this panel is a read-back so the text can be reviewed
// without leaving the card, and sending stays a thing Nick does in Gmail.
function SparkDraft({ draft }) {
  return (
    <div className="spark-draft">
      <div className="spark-draft-head">
        <span className="spark-draft-title">Drafted reply</span>
        <span className="spark-draft-unsent">draft is in Gmail — nothing has been sent</span>
      </div>
      <div className="spark-draft-field"><span>To</span>{draft.to}</div>
      <div className="spark-draft-field"><span>Subject</span>{draft.subject}</div>
      <pre className="spark-draft-body">{draft.body}</pre>
    </div>
  );
}

const LEDGER_GLYPH = {
  done: "✓", failed: "✕", blocked: "⚠", skip: "⤳",
  timer: "◷", warn: "⚠", sent: "→", handoff: "⇥", note: "✎", none: "·",
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

// Past runs are never pruned — every report stays on disk and can be reopened.
function SparkHistory({ spark, open, onToggle }) {
  useEffect(() => { spark.loadHistory(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const items = spark.history || [];
  if (!items.length) return null;
  const shown = open ? items : items.slice(0, 1);

  return (
    <div className="spark-history">
      {shown.map((h) => (
        <button
          key={h.runId}
          className={`spark-last-run${h.status === "interrupted" ? " is-interrupted" : ""}`}
          onClick={() => h.status !== "interrupted" && spark.showRun(h.runId)}
          title={h.status === "interrupted" ? (h.reason || "No report was produced") : "Open this report"}
        >
          <span className="spark-last-run-meta">
            {new Date(h.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            {h.certitude != null ? ` · ${h.certitude}%` : ""}
            {h.route ? ` · ${h.route}` : ""}
          </span>
          <span className="spark-last-run-headline">{h.headline}</span>
          {h.status === "interrupted" && h.reason && (
            <span className="spark-last-run-reason">{h.reason}</span>
          )}
        </button>
      ))}
      {items.length > 1 && (
        <button className="spark-history-toggle" onClick={onToggle}>
          {open ? "Hide" : `${items.length - 1} earlier spark${items.length > 2 ? "s" : ""}`}
        </button>
      )}
    </div>
  );
}

export default function SparkPanel({ spark, project, showToast, onGoToTerminal, onGoToRunroom, isAdmin }) {
  const [now, setNow] = useState(Date.now());
  const [historyOpen, setHistoryOpen] = useState(false);
  const running = spark.status === "scanning" || spark.status === "acting";

  const ticking = running || spark.status === "proposing";
  useEffect(() => {
    if (!ticking) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [ticking]);

  const elapsed = running && spark.startedAt
    ? Math.max(0, Math.round((now - spark.startedAt) / 1000))
    : spark.elapsedSec || 0;

  async function handleGo() {
    const res = await spark.start();
    if (res?.error) showToast(res.error);
  }

  function copyReport() {
    const r = spark.result;
    if (!r) return;
    const text = [
      r.where_it_stands,
      "",
      `Next step (${r.certitude?.pct}% certain, ${r.next_step?.route}): ${r.next_step?.text}`,
      r.next_step?.why || "",
      r.next_step?.first_action ? `First action: ${r.next_step.first_action}` : "",
      (r.recent || []).length ? "\nRecent:" : "",
      ...(r.recent || []).map((x) => `- ${x.date || "undated"} — ${x.text}`),
      r.risk ? `\nRisk: ${r.risk}` : "",
    ].filter(Boolean).join("\n");
    navigator.clipboard?.writeText(text);
    showToast("Report copied");
  }

  // ── idle ────────────────────────────────────────────────────────────────
  if (spark.loading) {
    return <div className="spark-panel"><div className="spark-stage spark-idle">Loading…</div></div>;
  }

  if (spark.status === "idle") {
    return (
      <div className="spark-panel">
        <div className="spark-stage spark-idle">
          <p className="spark-idle-copy">
            A {SWEEP_MINUTES}-minute refresh across every message front for this card — email,
            Google Voice, Google Chat, Notion, work sessions and artifacts — ending in one
            next step, a confidence number, and a way to get it done.
          </p>
          <button className="spark-go" onClick={handleGo} disabled={spark.busy || !isAdmin}
                  title={isAdmin ? undefined : "Spark runs are admin-only"}>
            {spark.busy ? "Starting…" : "Go"}
          </button>
          <SparkHistory spark={spark} open={historyOpen} onToggle={() => setHistoryOpen((v) => !v)} />
        </div>
      </div>
    );
  }

  // ── interrupted ─────────────────────────────────────────────────────────
  // The stream died mid-run. Say so plainly with how far it got — the failure
  // this replaces was a frozen checklist that looked like a hang forever.
  if (spark.status === "interrupted") {
    const reached = Object.entries(spark.fronts || {})
      .filter(([, f]) => f.state === "done" || f.state === "skipped");
    return (
      <div className="spark-panel">
        <div className="spark-stage spark-error">
          <p className="spark-error-msg">
            {spark.error?.message || "The run was interrupted before it finished."}
          </p>
          {reached.length > 0 && (
            <p className="spark-interrupted-note">
              It got through {reached.length} of {spark.frontOrder.length} fronts.
              Nothing was billed for the unfinished work.
            </p>
          )}
          <SparkFronts fronts={spark.fronts} order={spark.frontOrder} />
          <button className="spark-go" onClick={handleGo} disabled={spark.busy || !isAdmin}>
            Run it again
          </button>
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

  // Moving the conversation to a session means Spark is done: write the brief
  // and let go of the timer, then switch. Leaving it holding a timer while you
  // work in the terminal is how one gets stranded.
  async function doHandoff() {
    const res = await spark.handoff();
    if (res?.error) { showToast(res.error); return; }
    showToast("Brief written · Spark timer closed");
    if (project.tmux_session) onGoToTerminal();
  }

  const holdingTimer = ["proposing", "acting"].includes(spark.status) && spark.timerStarted;

  // ── running (scan only — an act round renders under the result) ──────────
  if (spark.status === "scanning" && !spark.result) {
    return (
      <div className="spark-panel">
        <div className="spark-stage spark-running">
          <SparkThinking verb={spark.verb} />
          <SparkFronts fronts={spark.fronts} order={spark.frontOrder} />
          <div className="spark-runfoot">
            {/* The counter answers "how long am I waiting"; the estimate beside
                it is what the entry bills. Same number, stated once. */}
            <span className={`spark-elapsed${elapsed > SWEEP_MINUTES * 60 ? " over" : ""}`}>
              {fmtElapsed(elapsed)} <span className="spark-elapsed-of">of ~{SWEEP_MINUTES} min</span>
            </span>
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
  const frontTrouble = (r.fronts || []).filter((f) => f.state === "unavailable").map((f) => f.front);

  const wrapsInMin = spark.idleWrapAt
    ? Math.max(0, Math.round((spark.idleWrapAt - now) / 60000))
    : null;

  return (
    <div className="spark-panel">
      <div className="spark-stage spark-result">
        {spark.viewingPast && (
          <div className="spark-past-banner">
            <span>Viewing the spark from {new Date(spark.viewingPast).toLocaleString()}</span>
            <button className="spark-btn" onClick={spark.backToIdle}>Back</button>
          </div>
        )}

        {holdingTimer && (
          <div className="spark-holding">
            <span>
              This Spark is holding a <strong>{spark.accruedMinutes}m</strong> timer open on the card
              {wrapsInMin != null && spark.status === "proposing"
                ? ` — it closes itself in ${wrapsInMin} min if nothing is decided.`
                : "."}
            </span>
          </div>
        )}

        <SparkCertitude certitude={r.certitude} />

        {r.where_it_stands && <p className="spark-stands">{r.where_it_stands}</p>}

        {r.risk && (
          <div className="spark-risk">
            <span className="spark-risk-label">Risk</span>
            <span>{r.risk}</span>
          </div>
        )}

        <SparkRecent recent={r.recent} />

        {spark.status === "proposing" && (
          <SparkDecision
            spark={spark}
            showToast={showToast}
            onGoToRunroom={onGoToRunroom}
            isAdmin={isAdmin}
          />
        )}

        {spark.status === "acting" && (
          <div className="spark-acting">
            <SparkThinking verb={spark.verb} />
            {spark.stepState?.detail && <p className="spark-acting-detail">{spark.stepState.detail}</p>}
          </div>
        )}

        {/* A finished run still shows what it recommended, without the buttons. */}
        {!["proposing", "acting"].includes(spark.status) && r.next_step && (
          <div className="spark-decision is-closed">
            <div className="spark-section-label">
              Next step
              {r.next_step.owner && <span className="spark-decision-owner">{r.next_step.owner}</span>}
            </div>
            <p className="spark-decision-text">{r.next_step.text}</p>
            {r.next_step.why && <p className="spark-decision-why">{r.next_step.why}</p>}
          </div>
        )}

        {spark.drafts.map((d) => <SparkDraft key={d.id} draft={d} />)}

        <SparkLedger ledger={spark.ledger} />

        {/* An error that arrives after a result used to be invisible: the error
            branch above requires !result, so this is the only place it shows. */}
        {spark.error && (
          <p className="spark-error-msg spark-error-inline">{spark.error.message}</p>
        )}

        {spark.accrualPaused && (
          <p className="spark-accrual-pause">
            This Spark has accrued 60 minutes. Further work belongs under a fresh timer —
            open a runroom to continue.
          </p>
        )}

        {/* Archived schema-1 runs carry a prose report the current schema does
            not produce. Keep it rather than dropping detail the sweep did. */}
        {r.body_md && (
          <details className="spark-fullreport">
            <summary>Full report</summary>
            <pre>{r.body_md}</pre>
          </details>
        )}

        <div className="spark-footer">
          <div className="spark-chips">
            <span className="spark-chip">
              {frontsChecked} of {spark.frontOrder.length} fronts
              {frontTrouble.length ? ` · ${frontTrouble.join(", ")} unread` : ""}
            </span>
            {spark.elapsedSec ? <span className="spark-chip">{fmtElapsed(spark.elapsedSec)}</span> : null}
            {spark.accruedMinutes ? <span className="spark-chip">{spark.accruedMinutes}m billed</span> : null}
            {spark.costUsd != null && <span className="spark-chip">${spark.costUsd.toFixed(2)}</span>}
            {spark.model && (
              <span className="spark-chip" title="scan model · round model">
                {spark.model}
                {spark.roundModel && spark.roundModel !== spark.model
                  ? ` · rounds ${spark.roundModel}`
                  : ""}
              </span>
            )}
            {r.style_warnings?.length > 0 && (
              <span className="spark-chip spark-chip-warn" title={r.style_warnings.join("; ")}>
                style
              </span>
            )}
          </div>
          <div className="spark-actions-row">
            <button className="spark-btn" onClick={copyReport}>Copy report</button>
            <button className="spark-btn" onClick={() => setHistoryOpen((v) => !v)}>History</button>
            {!["proposing", "acting"].includes(spark.status) && (
              <button className="spark-btn" onClick={handleGo} disabled={spark.busy || !isAdmin}>Run again</button>
            )}
            {project.tmux_session && (
              <button
                className="spark-btn"
                onClick={holdingTimer ? doHandoff : onGoToTerminal}
                disabled={spark.busy}
                title={holdingTimer ? "Writes a brief, closes the Spark timer, and switches tabs" : undefined}
              >
                Discuss in Terminal
              </button>
            )}
          </div>
        </div>

        {historyOpen && (
          <SparkHistory spark={spark} open onToggle={() => setHistoryOpen(false)} />
        )}
      </div>
    </div>
  );
}
