import { readdir, readFile } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";

const TIME_DIR = resolve(process.env.HOME, "OpenDia", "Time");

/**
 * Scan .timer-*.json state files and return active (no end field) timers.
 */
export async function getActiveTimers() {
  const files = await readdir(TIME_DIR).catch(() => []);
  const timerFiles = files.filter((f) => f.startsWith(".timer-") && f.endsWith(".json"));

  const active = [];
  for (const file of timerFiles) {
    try {
      const content = await readFile(join(TIME_DIR, file), "utf-8");
      const timer = JSON.parse(content);
      if (!timer.end) {
        active.push({
          client: timer.client || null,
          project: timer.project || null,
          division: timer.division || null,
          task: timer.task || null,
          start: timer.start || null,
        });
      }
    } catch {
      // skip malformed files
    }
  }
  return active;
}

/**
 * Parse a single daily time entry file into an array of entry objects.
 */
function parseEntries(content, filePath) {
  const entries = [];
  // Split on entry markers
  const blocks = content.split(/---\s*\n/);

  for (const block of blocks) {
    const markerMatch = block.match(/<!-- entry:(\S+) -->/);
    if (!markerMatch) continue;

    const entry = { marker: markerMatch[1], file: filePath };
    const lines = block.split("\n");

    let inNotes = false;
    const noteLines = [];

    for (const line of lines) {
      if (line.startsWith("<!-- entry:")) continue;

      if (inNotes) {
        if (line.match(/^---\s*$/) || line.match(/^[a-z_]+:\s/)) {
          inNotes = false;
        } else {
          noteLines.push(line.replace(/^ {2}/, ""));
          continue;
        }
      }

      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (kv) {
        const [, key, val] = kv;
        if (key === "notes" && (val === "|" || val === "")) {
          inNotes = val === "|";
          continue;
        }
        entry[key] = val || null;
      }
    }

    entry.notes = noteLines.join("\n").trim() || null;
    entries.push(entry);
  }

  return entries;
}

/**
 * Get all year/month directories, sorted descending.
 */
async function getTimeDirs() {
  const dirs = [];
  if (!existsSync(TIME_DIR)) return dirs;

  const years = await readdir(TIME_DIR);
  for (const year of years.filter((y) => /^\d{4}$/.test(y))) {
    const yearPath = join(TIME_DIR, year);
    const months = await readdir(yearPath).catch(() => []);
    for (const month of months.filter((m) => /^\d{2}$/.test(m))) {
      dirs.push(join(yearPath, month));
    }
  }
  return dirs.sort().reverse();
}

/**
 * Scan every daily .md file under ~/OpenDia/Time and return all completed
 * timer entries (entries with both a start and an end). Used by the backfill
 * endpoint to push historical entries into Notion.
 */
export async function getAllTimerEntries() {
  const results = [];
  const dirs = await getTimeDirs();

  for (const dir of dirs) {
    const files = await readdir(dir).catch(() => []);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

    for (const file of mdFiles) {
      const filePath = join(dir, file);
      const content = await readFile(filePath, "utf-8").catch(() => "");
      const entries = parseEntries(content, filePath);

      for (const entry of entries) {
        if (!entry.start || !entry.end) continue;
        results.push({
          client: entry.client || null,
          project: entry.project || null,
          division: entry.division || null,
          task: entry.task || null,
          start: entry.start,
          end: entry.end,
          duration: entry.duration || null,
          notes: entry.notes || null,
          billable: entry.billable === "true",
          estimated_minutes: entry.estimated_minutes
            ? parseInt(entry.estimated_minutes, 10)
            : null,
        });
      }
    }
  }

  return results;
}

/**
 * Find timer entries matching a project.
 * Matches on: (client=company AND division matches) OR project/task contains project name.
 * Returns most recent `limit` entries.
 */
export async function getTimerEntriesForProject(project, limit = 20) {
  const { company_name, division, name: projectName } = project;
  const nameLower = projectName.toLowerCase();
  const companyLower = company_name?.toLowerCase() || "";
  const divisionLower = division?.toLowerCase() || "";

  const results = [];
  const dirs = await getTimeDirs();

  for (const dir of dirs) {
    if (results.length >= limit) break;

    const files = await readdir(dir).catch(() => []);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();

    for (const file of mdFiles) {
      if (results.length >= limit) break;

      const filePath = join(dir, file);
      const content = await readFile(filePath, "utf-8");
      const entries = parseEntries(content, filePath);

      for (const entry of entries) {
        const entryClient = (entry.client || "").toLowerCase();
        const entryDiv = (entry.division || "").toLowerCase();
        const entryProject = (entry.project || "").toLowerCase();
        const entryTask = (entry.task || "").toLowerCase();

        const clientNameMatch =
          companyLower && entryClient && (
            entryClient === companyLower ||
            entryClient.includes(companyLower) ||
            companyLower.includes(entryClient)
          );
        const companyDivMatch =
          clientNameMatch && divisionLower && entryDiv === divisionLower;
        const projectNameMatch =
          nameLower && (entryProject.includes(nameLower) || entryTask.includes(nameLower));

        if (companyDivMatch || projectNameMatch) {
          results.push({
            date: entry.start?.slice(0, 10) || file.replace(".md", ""),
            start: entry.start || null,
            end: entry.end || null,
            duration: entry.duration || null,
            task: entry.task || null,
            notes: entry.notes || null,
            billable: entry.billable === "true",
            estimated_minutes: entry.estimated_minutes
              ? parseInt(entry.estimated_minutes, 10)
              : null,
          });
        }
      }
    }
  }

  // Sort by start descending
  results.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  return results.slice(0, limit);
}
