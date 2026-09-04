import { useEffect, useMemo, useState } from "react";
import useCompaniesList from "../hooks/useCompaniesList.js";
import ClientAutocomplete from "./ClientAutocomplete.jsx";
import { hasTag } from "../tags.js";

// "+ New" quick capture — single-field smart capture with progressive
// disclosure, not a wizard. One screen: type the task, resolve the client,
// pick new-card vs existing-card, adjust the inferred chips, go. Two finishing
// moves: Start session (card + Notion + brief + spawned tmux/claude session
// via POST /api/dispatch) or Create + plan first (card + Notion, then a Spark
// run through the existing route so the card lands in the Planroom).

const DIVISIONS = [
  "WordFlux", "WatchThreat", "AmPen", "Bedford AI", "ADA Web Work",
  "FluxCC", "Linnflux", "Admin", "Onboarding",
];

function deriveSession(shortName, task) {
  const base = `${shortName || "task"}-${(task || "").trim().split(/\s+/)[0] || "new"}`;
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
}

const STEP_LABELS = {
  company: "Client", card: "Card", notion: "Notion task",
  brief: "Brief", spawn: "Session", mode: "Mode", spark: "Spark run",
};

export default function NewTaskModal({ projects, onClose, showToast, onOpenCard, onOpenPlanroom }) {
  const { companies } = useCompaniesList();
  const [task, setTask] = useState("");
  const [clientQuery, setClientQuery] = useState("");
  const [company, setCompany] = useState(null);       // row from /api/companies
  const [newClient, setNewClient] = useState(null);   // { name } — inline create
  const [cardChoice, setCardChoice] = useState("new"); // "new" | project id
  const [division, setDivision] = useState("");
  const [divisionTouched, setDivisionTouched] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [sessionTouched, setSessionTouched] = useState(false);
  const [context, setContext] = useState("");
  const [phase, setPhase] = useState("form");         // form | busy | done
  const [result, setResult] = useState(null);         // POST /api/dispatch response (+ spark step)
  const [doneMode, setDoneMode] = useState("spawn");
  const [dupes, setDupes] = useState(null);           // { candidates, mode } from a 409 duplicate guard

  const clientName = company?.name || newClient?.name || "";

  // Cards, dominant division, and supervisor all derive from the projects the
  // app already holds — no extra fetches for display state.
  const clientProjects = useMemo(() => {
    if (!clientName) return [];
    return (projects || []).filter((p) => (p.company_name || "") === clientName);
  }, [projects, clientName]);

  const openCards = useMemo(
    () => clientProjects.filter((p) => p.status !== "completed"),
    [clientProjects]
  );

  const supervisor = useMemo(
    () => openCards.find((p) => hasTag(p, "supervisor")) || null,
    [openCards]
  );

  const dominantDivision = useMemo(() => {
    const counts = {};
    for (const p of clientProjects) if (p.division) counts[p.division] = (counts[p.division] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }, [clientProjects]);

  // Inferred defaults follow the inputs until the human touches the field.
  useEffect(() => {
    if (!divisionTouched) setDivision(dominantDivision);
  }, [dominantDivision, divisionTouched]);
  useEffect(() => {
    if (!sessionTouched) setSessionName(deriveSession(company?.short_name || newClient?.name?.split(/\s+/)[0], task));
  }, [company, newClient, task, sessionTouched]);
  // Picking a different client resets the card choice — a stale card id from
  // the previous client must never ride into the submit.
  useEffect(() => { setCardChoice("new"); setDupes(null); }, [clientName]);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && phase !== "busy") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  const existingCard = cardChoice !== "new" ? openCards.find((p) => p.id === cardChoice) : null;
  const canSubmit = phase === "form" && (existingCard || task.trim());

  async function submit(mode, overrides = {}) {
    if (!canSubmit) return;
    setPhase("busy");
    setDoneMode(mode);
    setDupes(null);
    const payload = {
      task: task.trim(),
      companyId: company?.id || undefined,
      newCompany: !company && newClient ? { name: newClient.name } : undefined,
      existingProjectId: overrides.existingProjectId ?? existingCard?.id ?? undefined,
      division: division || undefined,
      context: context.trim() || undefined,
      sessionName: mode === "spawn" ? sessionName.trim() || undefined : undefined,
      mode,
      force: overrides.force || undefined,
    };
    try {
      const r = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409 && Array.isArray(d?.candidates) && d.candidates.length) {
        // Duplicate guard fired: nothing was created. Show the candidates and
        // let the human decide — attach, or force a genuinely new card.
        setDupes({ candidates: d.candidates, mode });
        setPhase("form");
        return;
      }
      if (!r.ok) {
        showToast?.(d?.error || `HTTP ${r.status}`);
        setPhase("form");
        return;
      }
      if (mode === "plan" && d.projectId) {
        // Spark goes through its own route so the concurrency guards apply.
        const sr = await fetch(`/api/projects/${d.projectId}/spark`, { method: "POST" });
        const sd = await sr.json().catch(() => ({}));
        d.steps = [...(d.steps || []), {
          step: "spark", ok: sr.ok,
          detail: sr.ok ? `run ${sd.runId} started` : (sd?.error || `HTTP ${sr.status}`),
        }];
      }
      setResult(d);
      setPhase("done");
    } catch (e) {
      showToast?.(e.message);
      setPhase("form");
    }
  }

  function handleFormKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey && e.target.tagName !== "TEXTAREA" && canSubmit) {
      // Let the autocomplete's own Enter (item selection) win.
      if (e.target.closest(".client-autocomplete-wrap")) return;
      e.preventDefault();
      submit("spawn");
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => phase !== "busy" && onClose()}>
      <div className="newtask-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleFormKeyDown}>
        <h2 className="newtask-title">New Task</h2>

        {phase !== "done" && (
          <>
            <input
              className="newtask-task-input"
              value={task}
              onChange={(e) => { setTask(e.target.value); setDupes(null); }}
              placeholder="What needs doing?"
              autoFocus
              disabled={phase === "busy"}
            />

            <div className="newtask-grid">
              <label className="inbox-edit-label">Client</label>
              {clientName ? (
                <div className="newtask-chiprow">
                  <button className="newtask-chip" disabled={phase === "busy"}
                    onClick={() => { setCompany(null); setNewClient(null); setClientQuery(""); }}>
                    {clientName}{newClient ? " (new client)" : ""} ✕
                  </button>
                </div>
              ) : (
                <ClientAutocomplete
                  value={clientQuery}
                  onChange={setClientQuery}
                  companies={companies}
                  allowCreate
                  onSelect={(c) => {
                    if (c.__create) { setNewClient({ name: c.name }); setCompany(null); }
                    else { setCompany(c); setNewClient(null); }
                  }}
                />
              )}

              {openCards.length > 0 && (
                <>
                  <label className="inbox-edit-label">Card</label>
                  <div className="newtask-cards">
                    <label className="newtask-card-option">
                      <input type="radio" checked={cardChoice === "new"} onChange={() => setCardChoice("new")} />
                      <span>New card{task.trim() ? `: "${task.trim()}"` : ""}</span>
                    </label>
                    {openCards.slice(0, 6).map((p) => (
                      <label key={p.id} className="newtask-card-option">
                        <input type="radio" checked={cardChoice === p.id} onChange={() => setCardChoice(p.id)} />
                        <span>#{p.id} {p.name}{p.tmux_session ? ` · ${p.tmux_session}` : ""}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              <label className="inbox-edit-label">Division</label>
              <select className="inbox-edit-select" value={division} disabled={phase === "busy"}
                onChange={(e) => { setDivision(e.target.value); setDivisionTouched(true); }}>
                <option value="">—</option>
                {DIVISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>

              <label className="inbox-edit-label">Session</label>
              <input className="inbox-edit-input newtask-session" value={sessionName} disabled={phase === "busy"}
                onChange={(e) => { setSessionName(e.target.value); setSessionTouched(true); }} />

              {supervisor && (
                <>
                  <label className="inbox-edit-label">⌂</label>
                  <div className="newtask-supervisor">
                    Supervisor: <strong>{supervisor.tmux_session || supervisor.name}</strong> (#{supervisor.id}) — will be noted in the brief
                  </div>
                </>
              )}

              <label className="inbox-edit-label">Context</label>
              <textarea className="inbox-edit-notes" rows={4} value={context} disabled={phase === "busy"}
                onChange={(e) => setContext(e.target.value)}
                placeholder="Optional — paste an email, notes, anything. Lands in the session brief." />
            </div>

            {dupes && (
              <div className="newtask-dupes">
                <div className="newtask-dupes-title">This looks like existing work — nothing was created:</div>
                {dupes.candidates.map((c) => (
                  <div key={c.id} className="newtask-dupe-row">
                    <span className="newtask-dupe-name">
                      #{c.id} {c.name}
                      <em>{c.status === "wfhuman" ? "waiting on human" : "in progress"}</em>
                    </span>
                    <button className="newtask-dupe-attach" disabled={phase === "busy"}
                      onClick={() => { setCardChoice(c.id); submit(dupes.mode, { existingProjectId: c.id }); }}>
                      Attach to #{c.id}
                    </button>
                  </div>
                ))}
                <button className="newtask-dupe-force" disabled={phase === "busy"}
                  onClick={() => submit(dupes.mode, { force: true })}>
                  Create new card anyway
                </button>
              </div>
            )}

            <div className="newtask-actions">
              <button className="newtask-primary" disabled={!canSubmit} onClick={() => submit("spawn")}>
                {phase === "busy" && doneMode === "spawn" ? "Starting…" : "Start session"}
              </button>
              <button className="newtask-secondary" disabled={!canSubmit} onClick={() => submit("plan")}>
                {phase === "busy" && doneMode === "plan" ? "Creating…" : "Create + plan first"}
              </button>
              <button className="newtask-cancel" disabled={phase === "busy"} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {phase === "done" && result && (
          <>
            <ul className="newtask-steps">
              {(result.steps || []).map((s, i) => (
                <li key={i} className={s.ok ? "ok" : "fail"}>
                  <span className="newtask-step-mark">{s.ok ? "✓" : "✗"}</span>
                  <span className="newtask-step-label">{STEP_LABELS[s.step] || s.step}</span>
                  <span className="newtask-step-detail">{s.detail}</span>
                </li>
              ))}
            </ul>
            {result.sessionName && (
              <p className="newtask-session-note">
                Session <code>{result.sessionName}</code> is live — attach with{" "}
                <code>tmux attach -t {result.sessionName}</code> or the card's Terminal tab.
              </p>
            )}
            <div className="newtask-actions">
              {result.projectId && (
                <button className="newtask-primary" onClick={() => onOpenCard?.(result.projectId)}>Open card</button>
              )}
              {doneMode === "plan" && result.projectId && (
                <button className="newtask-secondary" onClick={() => onOpenPlanroom?.(result.projectId)}>Open planroom</button>
              )}
              <button className="newtask-cancel" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
