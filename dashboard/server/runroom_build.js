// runroom_build.js — the only thing in the server that CREATES a runroom.
//
// runrooms.js is deliberately read-only ("the directory IS the registry"), and
// that property is worth keeping: nothing there can corrupt a plan a live
// session owns. So the writer lives here instead, and it writes exactly once,
// at the moment a room is opened.
//
// A runroom is two things that must both exist or neither is useful:
//
//   1. ~/OpenDia/runrooms/<tmux-session>/plan.json — the plan the page renders
//   2. a tmux session of that name running claude — every button in the page
//      works by `tmux send-keys` into that pane
//
// Which is why the session name is resolved BEFORE anything is written: the
// plan lives in a directory named after the session, so discovering the name
// afterwards (from dispatch_spawn.sh's echo) would mean writing the plan
// somewhere and then finding out it belonged somewhere else.

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "fs";

import { etNow } from "./timerfile.js";

const HOME = process.env.HOME || "/home/linnflux";
export const RUNROOM_ROOT = `${HOME}/OpenDia/runrooms`;
const SPAWN_SCRIPT = `${HOME}/OpenDia/repo/scripts/dispatch_spawn.sh`;

/** tmux session names are keys in a directory path and a `-t` argument. */
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "card";
}

// Exported (additive — resolveFreeSession remains the only in-file caller)
// so the Mailroom's fixed-name ensure-session route can check for the
// standing `mailroom` session without reimplementing the tmux probe.
export function sessionExists(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first free session name, using dispatch_spawn.sh's own `-2, -3, …`
 * convention so both agree on what a collision looks like.
 *
 * A name that is free here can in principle be taken between this call and the
 * spawn. dispatch_spawn.sh would then suffix past it and the seeded plan would
 * be orphaned under the un-suffixed name — which is why openRunroom logs that
 * case rather than pretending the room opened where it says.
 */
export function resolveFreeSession(preferred) {
  const base = slugify(preferred);
  if (!sessionExists(base)) return base;
  for (let n = 2; n < 50; n += 1) {
    const candidate = `${base}-${n}`;
    if (!sessionExists(candidate)) return candidate;
  }
  throw new Error(`no free session name near "${base}"`);
}

/** The detail pane is read at arm's length mid-task, so this stays short: why
 *  the step matters, the literal first move, and the evidence behind it. */
function stepDetail(step, result) {
  const parts = [];
  if (step.why) parts.push(step.why);
  if (step.first_action) parts.push("```bash\n" + step.first_action + "\n```");
  const recent = (result?.recent || []).slice(0, 4);
  if (recent.length) {
    parts.push("**What led here**\n" + recent
      .map((r) => `- ${r.date || "undated"}${r.front ? ` · ${r.front}` : ""} — ${r.text}`)
      .join("\n"));
  }
  if (result?.certitude?.pct != null) {
    parts.push(`Spark rated this ${result.certitude.pct}% certain` +
      (result.certitude.reason ? ` — ${result.certitude.reason}` : "."));
  }
  return parts.join("\n\n");
}

/**
 * Write the seed plan. One step, because Spark produces one step — the session
 * that adopts the room is expected to rewrite the steps array as the plan
 * develops, which the /runroom contract already requires of it.
 */
export function writeSeedPlan({ session, project, run }) {
  const dir = `${RUNROOM_ROOT}/${session}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/plan.json`;

  // The skill archives an existing plan before replacing it; a room opened over
  // a live one would otherwise silently discard whatever it was tracking.
  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, "utf8"));
      const stamp = String(prev.created || etNow().iso).replace(/[^\w-]/g, "-");
      renameSync(file, `${dir}/plan-${stamp}.json`);
    } catch {
      renameSync(file, `${dir}/plan-superseded-${Date.now()}.json`);
    }
  }

  const result = run.result || {};
  const step = result.next_step || {};
  const plan = {
    runroom_version: 1,
    title: (step.text || `${project.name} — next step`).slice(0, 80),
    card_id: project.id,
    card_name: project.name,
    company: project.company_name || "",
    division: project.division || "",
    tmux_session: session,
    // Resolvable only from inside the session; the page works without it, and
    // the session fills it in when it adopts the plan.
    claude_session_id: null,
    claude_cwd: `${HOME}/OpenDia`,
    created: etNow().iso,
    status: "active",
    current_step: 1,
    steps: [{
      n: 1,
      title: (step.text || "Next step").slice(0, 60),
      actor: "human",
      state: "current",
      detail: stepDetail(step, result),
      note: `Seeded from Spark run ${run.id}.`,
    }],
    note: "Opened from the Spark tab. The plan is a seed: rewrite the steps as the real shape emerges.",
  };

  writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

/**
 * Spawn the session. dispatch_spawn.sh starts claude in plan mode on opusplan
 * and echoes the name it actually used, which is the value to trust.
 */
export function spawnSession(session, briefPath) {
  const out = execFileSync("bash", [SPAWN_SCRIPT, session, briefPath], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, HOME },
  });
  return out.trim().split("\n").pop().trim();
}

/**
 * Move a seeded plan to the name the spawn actually took.
 *
 * Only reachable when something claimed the resolved name between the check and
 * the spawn. Rare, but the alternative is a room whose page renders nothing
 * because its plan is one directory over. Returns the plan's new path, or null
 * if the destination already holds a plan — in which case the seed is left
 * where it is rather than overwriting a live one.
 */
export function relocatePlan(fromSession, toSession) {
  const from = `${RUNROOM_ROOT}/${fromSession}`;
  const to = `${RUNROOM_ROOT}/${toSession}`;
  if (!existsSync(`${from}/plan.json`)) return null;
  if (existsSync(`${to}/plan.json`)) return null;
  mkdirSync(to, { recursive: true });
  const plan = JSON.parse(readFileSync(`${from}/plan.json`, "utf8"));
  plan.tmux_session = toSession;
  writeFileSync(`${to}/plan.json`, JSON.stringify(plan, null, 2));
  renameSync(`${from}/plan.json`, `${from}/plan-relocated-${toSession}.json`);
  return `${to}/plan.json`;
}
