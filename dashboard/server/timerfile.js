// timerfile.js — the on-disk timer format, in one place.
//
// A timer is two artifacts that must stay in step: an entry appended to the
// daily markdown ledger (`Time/YYYY/MM/YYYY-MM-DD.md`, anchored by an
// `<!-- entry:MARKER -->` comment) and a state file (`Time/.timer-MARKER.json`)
// that marks it as still running. `/od-go`, `/od-stop`, `/timer-status` and the
// python billing scripts all read the same pair.
//
// These functions were extracted verbatim from terminal.js so more than one
// feature can start and close timers without depending on the tmux/pty module.
// The optional arguments added here all default to the previous behaviour, so
// existing call sites are unaffected.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync
} from "fs";

const HOME = process.env.HOME || "/home/linnflux";
export const TIMER_DIR = `${HOME}/OpenDia/Time`;

/** Current wall time in Eastern, pre-split into the pieces markers need. */
export function etNow() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const h = parts.hour === "24" ? "00" : parts.hour;
  return {
    YYYY: parts.year,
    MM: parts.month,
    DD: parts.day,
    HH: h,
    mm: parts.minute,
    iso: `${parts.year}-${parts.month}-${parts.day}T${h}:${parts.minute}`
  };
}

/** "45m" / "2h" / "1h 30m" — the ledger's duration format. */
export function durationStr(startIso, endIso) {
  const pad = s => s.length === 16 ? s + ":00" : s;
  const diffMin = Math.max(1, Math.round((new Date(pad(endIso)) - new Date(pad(startIso))) / 60000));
  if (diffMin < 60) return `${diffMin}m`;
  const h = Math.floor(diffMin / 60), m = diffMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Whole-minute elapsed time between two markers, for accrual maths. */
export function minutesBetween(startIso, endIso) {
  const pad = s => s.length === 16 ? s + ":00" : s;
  return Math.max(1, Math.round((new Date(pad(endIso)) - new Date(pad(startIso))) / 60000));
}

/**
 * Find the running timer bound to a tmux session.
 *
 * Callers that start a timer NOT tied to a session (the dashboard's Spark runs)
 * deliberately write an empty `tmux_session` so they can never be matched here —
 * otherwise take-control would think a work timer was already running.
 */
export function findTimerForSession(session) {
  try {
    for (const f of readdirSync(TIMER_DIR)) {
      if (!f.startsWith(".timer-") || !f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(`${TIMER_DIR}/${f}`, "utf8"));
        if (data.tmux_session === session) return { file: `${TIMER_DIR}/${f}`, data };
      } catch {}
    }
  } catch {}
  return null;
}

/** Every running timer, whether or not it is bound to a session. */
export function listRunningTimers() {
  const out = [];
  try {
    for (const f of readdirSync(TIMER_DIR)) {
      if (!f.startsWith(".timer-") || !f.endsWith(".json")) continue;
      try {
        out.push({
          file: `${TIMER_DIR}/${f}`,
          data: JSON.parse(readFileSync(`${TIMER_DIR}/${f}`, "utf8"))
        });
      } catch {}
    }
  } catch {}
  return out;
}

/**
 * Append a new open entry to today's ledger and write its state file.
 *
 * opts.estimatedMinutes — what the entry bills (estimate, not stopwatch).
 * opts.tmuxSession      — pass "" for a timer no tmux session owns.
 * opts.extra            — merged into the state file (provenance fields).
 */
export function startTimerForProject(project, taskOverride, opts = {}) {
  const {
    estimatedMinutes = 30,
    tmuxSession = project.tmux_session || "",
    extra = {}
  } = opts;

  const t = etNow();
  const task = taskOverride || project.next_step || `${project.name} — dashboard terminal session`;
  const billable = !["Admin", "Onboarding"].includes(project.division);
  const marker = t.iso;

  const yearDir = `${TIMER_DIR}/${t.YYYY}/${t.MM}`;
  mkdirSync(yearDir, { recursive: true });
  const dailyFile = `${yearDir}/${t.YYYY}-${t.MM}-${t.DD}.md`;

  if (!existsSync(dailyFile)) {
    writeFileSync(dailyFile, `# Time Entries - ${t.YYYY}-${t.MM}-${t.DD}\n`);
  }

  appendFileSync(dailyFile, [
    ``,
    `---`,
    `<!-- entry:${marker} -->`,
    `client: ${project.company_name || project.name}`,
    `project: ${project.name}`,
    `division: ${project.division || ""}`,
    `task: ${task}`,
    `estimated_minutes: ${estimatedMinutes}`,
    `start: ${marker}`,
    `end:`,
    `duration:`,
    `billable: ${billable}`,
    // Attribution must live in the entry itself: the state file (which also
    // carries started_by) is deleted on close, and billing reads the markdown.
    ...(extra.started_by ? [`started_by: ${extra.started_by}`] : []),
    `notes:`,
    `---`,
    ``
  ].join("\n"));

  const stateFile = stateFileFor(marker);
  writeFileSync(stateFile, JSON.stringify({
    client: project.company_name || project.name,
    project: project.name,
    division: project.division || "",
    task,
    billable,
    start: marker,
    file: dailyFile,
    marker,
    tmux_session: tmuxSession,
    project_id: project.id,
    // Mirrored from the markdown entry. A reader that only has the state file
    // (spark.js recovering a run after a restart) would otherwise have to guess
    // the estimate, and guessing means losing whatever the run had accrued.
    estimated_minutes: estimatedMinutes,
    ...extra
  }, null, 2));

  return { stateFile, marker, dailyFile, task, estimatedMinutes };
}

/** The state file that pairs with a marker. Derived, never stored — the two
 *  artifacts are keyed by the same marker, so there is nothing to keep in sync. */
export function stateFileFor(marker) {
  return `${TIMER_DIR}/.timer-${marker.replace(/:/g, "-")}.json`;
}

/**
 * Rewrite the open entry's `estimated_minutes:` line in place, in BOTH
 * artifacts.
 *
 * The markdown is what bills, so it is the one that must not fail. The state
 * file is best-effort: a still-running timer whose JSON says 15 while the
 * ledger says 40 is the drift that made recovered Spark runs lose their
 * accrual, but a state file that cannot be written should not stop the estimate
 * landing where the money is read from.
 */
export function setEntryEstimate(dailyFile, marker, estimatedMinutes) {
  try {
    const content = readFileSync(dailyFile, "utf8");
    const anchor = `<!-- entry:${marker} -->`;
    const idx = content.indexOf(anchor);
    if (idx === -1) return false;
    const sectionEnd = content.indexOf("\n---", idx + anchor.length);
    if (sectionEnd === -1) return false;
    const section = content.slice(idx, sectionEnd)
      .replace(/\nestimated_minutes: \d+\n/, `\nestimated_minutes: ${estimatedMinutes}\n`);
    writeFileSync(dailyFile, content.slice(0, idx) + section + content.slice(sectionEnd));
  } catch {
    return false;
  }

  const stateFile = stateFileFor(marker);
  try {
    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, "utf8"));
      data.estimated_minutes = estimatedMinutes;
      writeFileSync(stateFile, JSON.stringify(data, null, 2));
    }
  } catch {}
  return true;
}

/**
 * Close an open entry: fill end/duration, attach notes, optionally rewrite the
 * estimate (used when a run is cancelled and the 15-minute estimate would be a
 * phantom).
 */
export function closeTimerEntry(dailyFile, marker, endIso, notes, estimatedMinutes = null) {
  const duration = durationStr(marker, endIso);
  let content = readFileSync(dailyFile, "utf8");
  const anchor = `<!-- entry:${marker} -->`;
  const idx = content.indexOf(anchor);
  if (idx === -1) return false;

  const sectionEnd = content.indexOf("\n---", idx + anchor.length);
  let section = content.slice(idx, sectionEnd);

  section = section
    .replace(/\nend:\n/, `\nend: ${endIso}\n`)
    .replace(/\nduration:\n/, `\nduration: ${duration}\n`);

  if (estimatedMinutes !== null) {
    section = section.replace(/\nestimated_minutes: \d+\n/, `\nestimated_minutes: ${estimatedMinutes}\n`);
  }

  if (notes) {
    const indented = notes.split("\n").map(l => `  ${l}`).join("\n");
    // `notes:` is the LAST line of the sliced section — the newline that
    // follows it belongs to the closing `---`, so a /\nnotes:\n/ pattern can
    // never match and notes were silently dropped. Handle both shapes.
    if (/\nnotes:[ \t]*\n/.test(section)) {
      section = section.replace(/\nnotes:[ \t]*\n/, `\nnotes: |\n${indented}\n`);
    } else {
      section = section.replace(/\nnotes:[ \t]*$/, `\nnotes: |\n${indented}`);
    }
  }

  writeFileSync(dailyFile, content.slice(0, idx) + section + content.slice(sectionEnd));
  return true;
}
