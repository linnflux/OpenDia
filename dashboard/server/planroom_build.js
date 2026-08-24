// planroom_build.js — the only thing in the server that WRITES a planroom.
//
// A planroom is the standing plan for one project card: ~/OpenDia/planrooms/
// <cardId>/plan.json. Spark is the verb that creates or refreshes it, and a
// runroom ADOPTS it when the work becomes a session. That is the Plan → Run
// half of the loop the product is built around — one document flowing through,
// not a one-step seed handed over and then forgotten.
//
// Three properties the layout depends on:
//
//   * It lives in its own root, keyed by card. Not under ~/OpenDia/spark/<card>/
//     — agents.js reads the mtime of everything there as the "last scanned"
//     signal, and a plan rewritten beside the runs would move it. Not under
//     ~/OpenDia/runrooms/ — that root means "one dir = one tmux session", and a
//     planroom has no session; the gate would render it as a dead room.
//
//   * The schema is runroom-v1 plus an extension block, so the room renderers
//     (RoomHeader, the rail, StateGlyph) draw it untouched. `room_type` gains
//     its first real reader here; the /mailroom skill already writes the key.
//
//   * A scan REPLACES the plan; rounds within a run ACCUMULATE. `steps` is a
//     pure function of the run, so persisting after every round can never
//     drift from result.json. Spark's claim is "what to do next, now" — a step
//     from last week's scan was not re-verified by this one and would be stale
//     weight a runroom then inherits. History is recent[] plus the run archive.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, statSync } from "fs";

import { etNow } from "./timerfile.js";
import { RUNROOM_ROOT } from "./runroom_build.js";

const HOME = process.env.HOME || "/home/linnflux";
export const PLANROOM_ROOT = `${HOME}/OpenDia/planrooms`;

function planPath(cardId) {
  return `${PLANROOM_ROOT}/${cardId}/plan.json`;
}

/**
 * The date a card is scheduled for, from the next_step calendar contract
 * ("YYYY-MM-DD: action" or "YYYY-MM-DD HH:MM: action"). Null when undated.
 * Shared by spark's recheck gate, the park route, and the ODA wake roster so
 * they can never disagree about what "scheduled" means.
 */
export function nextStepDate(nextStep) {
  const m = String(nextStep || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** The standing plan for a card, or null. Never throws. */
export function readPlanroom(cardId) {
  try {
    return JSON.parse(readFileSync(planPath(cardId), "utf8"));
  } catch {
    return null;
  }
}

/** Every card that has a plan, with the file's mtime for staleness. */
export function listPlanrooms() {
  if (!existsSync(PLANROOM_ROOT)) return [];
  const out = [];
  for (const name of readdirSync(PLANROOM_ROOT)) {
    const cardId = Number(name);
    if (!Number.isInteger(cardId)) continue;
    const plan = readPlanroom(cardId);
    if (!plan) continue;
    let mtime = 0;
    try { mtime = statSync(planPath(cardId)).mtimeMs; } catch {}
    out.push({ cardId, plan, mtime });
  }
  return out;
}

/**
 * The detail pane is read at arm's length mid-task, so this stays short: why
 * the step matters, the literal first move, and the evidence behind it. Moved
 * here from runroom_build.js; the seed path it served is superseded.
 */
export function stepDetail(step, report) {
  const parts = [];
  if (step?.why) parts.push(step.why);
  if (step?.first_action) parts.push("```bash\n" + step.first_action + "\n```");
  const recent = (report?.recent || []).slice(0, 4);
  if (recent.length) {
    parts.push("**What led here**\n" + recent
      .map((r) => `- ${r.date || "undated"}${r.front ? ` · ${r.front}` : ""} — ${r.text}`)
      .join("\n"));
  }
  if (report?.certitude?.pct != null) {
    parts.push(`Spark rated this ${report.certitude.pct}% certain` +
      (report.certitude.reason ? ` — ${report.certitude.reason}` : "."));
  }
  return parts.join("\n\n");
}

/**
 * steps[] as a pure function of a run: every outcome the rounds produced, in
 * order, then the open next step as `current`. An outcome carried out by the
 * act phase is OpenDia's; an operator attestation is a human's.
 */
export function stepsFromRun(run) {
  const report = run.result || {};
  const steps = [];
  for (const o of run.outcomes || []) {
    if (!o || o.status === "none") continue;
    steps.push({
      n: steps.length + 1,
      title: String(o.note_bullet || o.summary || "Step").slice(0, 60),
      actor: o.by === "human" ? "human" : "opendia",
      state: o.status === "done" ? "done" : o.status === "blocked" ? "skipped" : "failed",
      detail: [o.summary, o.evidence ? `Evidence: ${o.evidence}` : ""].filter(Boolean).join("\n\n"),
      note: o.evidence || "",
    });
  }
  const step = report.next_step;
  let current = null;
  if (step?.text) {
    current = steps.length + 1;
    steps.push({
      n: current,
      title: String(step.text).slice(0, 60),
      actor: step.route === "opendia" ? "opendia" : "human",
      state: "current",
      detail: stepDetail(step, report),
      note: "",
    });
  }
  return { steps, current };
}

/**
 * Archive the plan on disk as plan-<created>.json before a rewrite — the same
 * convention the /runroom skill and writeSeedPlan use, so a human reading the
 * directory sees one shape everywhere.
 */
function archiveExisting(dir, file) {
  if (!existsSync(file)) return null;
  try {
    const prev = JSON.parse(readFileSync(file, "utf8"));
    const stamp = String(prev.created || etNow().iso).replace(/[^\w-]/g, "-");
    const dest = `${dir}/plan-${stamp}.json`;
    renameSync(file, dest);
    return prev;
  } catch {
    renameSync(file, `${dir}/plan-superseded-${Date.now()}.json`);
    return null;
  }
}

/** True when the runroom a pointer names still exists and is still live. */
function runroomStillActive(adoptedBy) {
  if (!adoptedBy?.tmux_session) return false;
  try {
    const p = JSON.parse(readFileSync(`${RUNROOM_ROOT}/${adoptedBy.tmux_session}/plan.json`, "utf8"));
    return p.status === "active";
  } catch {
    return false;
  }
}

/**
 * Write (or replace) the standing plan from a run. Called after the scan and
 * after every round, so the file always says what Spark believes right now.
 *
 * If the previous plan had been adopted into a runroom that is STILL active,
 * the pointer is carried forward: a nightly ODA scan must not sever the link
 * to a room someone is working in.
 */
export function writePlanroomFromRun(run, project) {
  const dir = `${PLANROOM_ROOT}/${project.id}`;
  mkdirSync(dir, { recursive: true });
  const file = planPath(project.id);
  const report = run.result || {};
  const step = report.next_step || null;

  // A refresh of the same run rewrites in place; a NEW run archives the old plan.
  const prev = readPlanroom(project.id);
  const sameRun = prev?.planroom?.spark_run_id === run.id;
  if (prev && !sameRun) archiveExisting(dir, file);

  const { steps, current } = stepsFromRun(run);
  const now = etNow().iso;
  const carried = prev?.adopted_by && runroomStillActive(prev.adopted_by) ? prev.adopted_by : null;

  const plan = {
    runroom_version: 1,
    room_type: "planroom",
    title: (step?.text || report.where_it_stands || `${project.name} — plan`).slice(0, 80),
    card_id: project.id,
    card_name: project.name,
    company: project.company_name || "",
    division: project.division || "",
    tmux_session: null,
    claude_session_id: null,
    claude_cwd: `${HOME}/OpenDia`,
    created: sameRun && prev?.created ? prev.created : now,
    updated: now,
    status: carried ? "adopted" : "active",
    current_step: current,
    steps,
    note: current == null
      ? "No open step — the ball is in someone else's court."
      : "",
    planroom: {
      spark_run_id: run.id,
      sparked_at: sameRun && prev?.planroom?.sparked_at ? prev.planroom.sparked_at : now,
      sparked_by: run.startedBy || "",
      certitude: report.certitude || null,
      where_it_stands: report.where_it_stands || "",
      recent: report.recent || [],
      risk: report.risk || null,
      fronts: report.fronts || [],
      route: step?.route || null,
      estimated_minutes: step?.estimated_minutes ?? null,
      first_action: step?.first_action || null,
      by_when: step?.by_when || null,
      owner: step?.owner || null,
    },
    adopted_by: carried,
  };

  writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

/**
 * Copy the standing plan into a runroom and leave a pointer behind.
 *
 * Copy, not move: moving makes the card vanish from the planroom list and
 * leaves the next spark nothing to archive. Copy, not symlink: a symlink would
 * let the next spark overwrite the LIVE runroom plan through it, and the
 * skill's rename-to-plan-<created> would dangle it. After this the runroom
 * file is the only live document — the session owns it per the existing
 * contract — and the planroom reads through to it until the next spark.
 */
export function adoptIntoRunroom({ plan, session, project, runId }) {
  const dir = `${RUNROOM_ROOT}/${session}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/plan.json`;
  archiveExisting(dir, file);

  const now = etNow().iso;
  // eslint-disable-next-line no-unused-vars
  const { room_type, adopted_by, updated, ...base } = plan;
  const adopted = {
    ...base,
    tmux_session: session,
    status: "active",
    created: now,
    // A plan with no open step still adopts — the session decides what is next.
    current_step: plan.current_step ?? 1,
    adopted_from: {
      planroom_card_id: project.id,
      spark_run_id: runId || plan.planroom?.spark_run_id || null,
      at: now,
    },
    note: "Adopted from the card's planroom. Refine the steps in place as the real shape emerges.",
  };
  writeFileSync(file, JSON.stringify(adopted, null, 2));

  markPlanroomAdopted(project.id, { session, planFile: file });
  return file;
}

/** Point the planroom at the runroom now holding its plan. */
export function markPlanroomAdopted(cardId, { session, planFile }) {
  const plan = readPlanroom(cardId);
  if (!plan) return null;
  plan.status = "adopted";
  plan.adopted_by = { tmux_session: session, plan_file: planFile, at: etNow().iso };
  plan.updated = etNow().iso;
  writeFileSync(planPath(cardId), JSON.stringify(plan, null, 2));
  return plan;
}

/**
 * Park the standing plan until a date — normally the next_step's own date.
 * A parked plan leaves the working set: the operator has decided nothing
 * needs doing before then, so the room stops asking. Three things wake it:
 * the date arriving (the ODA wake duty rechecks it), a delta check finding
 * new communication, or a fresh full scan replacing the plan outright.
 */
export function markPlanroomParked(cardId, { until, by }) {
  const plan = readPlanroom(cardId);
  if (!plan) return null;
  plan.status = "parked";
  plan.parked = { until, at: etNow().iso, by: by || "" };
  plan.note = `Parked until ${until} — nothing to do before then.`;
  plan.updated = etNow().iso;
  writeFileSync(planPath(cardId), JSON.stringify(plan, null, 2));
  return plan;
}

/** Bring a parked plan back into play, with a note saying why it woke. */
export function unparkPlanroom(cardId, { note } = {}) {
  const plan = readPlanroom(cardId);
  if (!plan || plan.status !== "parked") return null;
  plan.status = "active";
  delete plan.parked;
  plan.note = note || "";
  plan.updated = etNow().iso;
  writeFileSync(planPath(cardId), JSON.stringify(plan, null, 2));
  return plan;
}

/**
 * A recheck came back clean: nothing new on any front, so the plan itself is
 * untouched — no rewrite, no archive, no step churn. The stamp is the only
 * trace, so the list can say "checked, no change" instead of looking stale.
 */
export function stampPlanroomChecked(cardId, { runId, by }) {
  const plan = readPlanroom(cardId);
  if (!plan?.planroom) return null;
  plan.planroom.checked = { at: etNow().iso, by: by || "", spark_run_id: runId || null, no_change: true };
  plan.updated = etNow().iso;
  writeFileSync(planPath(cardId), JSON.stringify(plan, null, 2));
  return plan;
}

/**
 * The operator says they did the open step themselves. Mark it done with their
 * note, leaving no open step — the next spark decides what comes next.
 */
export function markStepDone(cardId, { note, by }) {
  const plan = readPlanroom(cardId);
  if (!plan || plan.current_step == null) return null;
  const step = plan.steps.find((s) => s.n === plan.current_step);
  if (!step) return null;
  step.state = "done";
  step.actor = "human";
  step.note = note ? `${by ? `${by}: ` : ""}${note}` : `Done by ${by || "the operator"}.`;
  plan.current_step = null;
  plan.note = "Open step attested done by the operator — spark again for what comes next.";
  plan.updated = etNow().iso;
  writeFileSync(planPath(cardId), JSON.stringify(plan, null, 2));
  return plan;
}

/**
 * The operator dismisses the standing plan outright — the work is done or
 * moot and nothing here should run. Archives it under the same plan-<created>
 * convention a re-spark uses, then leaves the card with no planroom, so the
 * next spark starts clean. Distinct from attestation (which closes only the
 * open step) and from parking (which keeps the plan for a date).
 */
export function dismissPlanroom(cardId, { note, by } = {}) {
  const plan = readPlanroom(cardId);
  if (!plan) return { error: "no standing plan to dismiss" };
  if (plan.status === "adopted" && runroomStillActive(plan.adopted_by)) {
    return { error: `adopted by ${plan.adopted_by.tmux_session} — close that run first` };
  }
  const dir = `${PLANROOM_ROOT}/${cardId}`;
  const file = planPath(cardId);
  plan.dismissed = { at: etNow().iso, by: by || "", note: note || "" };
  plan.updated = etNow().iso;
  try {
    writeFileSync(file, JSON.stringify(plan, null, 2));
  } catch {}
  archiveExisting(dir, file);
  return { ok: true };
}

/**
 * Eject an adoption: the run is over (closed, abandoned, or dead) and the
 * plan returns to standing. Refused while the runroom is still live — close
 * the run first, then eject. Without this, a planroom points at its finished
 * run until the next re-spark happens to notice.
 */
export function ejectPlanroom(cardId, { by } = {}) {
  const plan = readPlanroom(cardId);
  if (!plan) return { error: "no planroom on this card" };
  if (plan.status !== "adopted") return { error: "plan is not in a run" };
  if (runroomStillActive(plan.adopted_by)) {
    return { error: `run ${plan.adopted_by.tmux_session} is still active — close it first` };
  }
  const session = plan.adopted_by?.tmux_session || "?";
  plan.status = "active";
  plan.adopted_by = null;
  plan.note = `Ejected from run ${session} by ${by || "the operator"} — plan stands again.`;
  plan.updated = etNow().iso;
  writeFileSync(planPath(cardId), JSON.stringify(plan, null, 2));
  return { ok: true };
}
