import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { execFile } from "child_process";

const ALERTS_FILE = resolve(process.env.HOME, "OpenDia", "Time", ".deadline-alerts.json");
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

export function readDeadlineCache() {
  try {
    const raw = readFileSync(ALERTS_FILE, "utf-8");
    const data = JSON.parse(raw);
    const generated = data.generated ? new Date(data.generated) : null;
    const stale = !generated || (Date.now() - generated.getTime() > STALE_MS);
    return {
      overdue: data.overdue || [],
      imminent: data.imminent || [],
      today: data.today || [],
      generated: data.generated || null,
      stale,
    };
  } catch (err) {
    return { overdue: [], imminent: [], today: [], generated: null, stale: true, error: err.message };
  }
}

export function refreshDeadlineCache() {
  return new Promise((resolve, reject) => {
    const script = `${process.env.HOME}/OpenDia/scripts/deadline_check.py`;
    execFile("python3", [script, "--hello"], { timeout: 60000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2));
        resolve(data);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function addDays(s, days) {
  if (!s) return s;
  if (s.length === 10) {
    const d = new Date(s + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(T.*)$/);
  if (!m) return s;
  const d = new Date(m[1] + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) + m[2];
}

export function bumpDeadlineInCache(notionId, weeks = 1) {
  if (!notionId) return null;
  try {
    const raw = readFileSync(ALERTS_FILE, "utf-8");
    const data = JSON.parse(raw);
    const days = weeks * 7;
    let updated = null;
    const bump = (t) => {
      if (t.id !== notionId) return t;
      const newStart = addDays(t.due_start, days);
      const newEnd = t.due_end ? addDays(t.due_end, days) : null;
      updated = { start: newStart, end: newEnd };
      return { ...t, due_start: newStart, due_end: newEnd };
    };
    data.overdue = (data.overdue || []).map(bump);
    data.imminent = (data.imminent || []).map(bump);
    data.today = (data.today || []).map(bump);
    if (!updated) return null;
    writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2));
    return updated;
  } catch {
    return null;
  }
}

export function getCachedDeadlineRow(notionId) {
  if (!notionId) return null;
  try {
    const raw = readFileSync(ALERTS_FILE, "utf-8");
    const data = JSON.parse(raw);
    const all = [...(data.overdue || []), ...(data.imminent || []), ...(data.today || [])];
    return all.find((t) => t.id === notionId) || null;
  } catch {
    return null;
  }
}

export function removeFromDeadlineCache(notionId) {
  if (!notionId) return false;
  try {
    const raw = readFileSync(ALERTS_FILE, "utf-8");
    const data = JSON.parse(raw);
    const filter = (arr) => (arr || []).filter((t) => t.id !== notionId);
    data.overdue = filter(data.overdue);
    data.imminent = filter(data.imminent);
    data.today = filter(data.today);
    writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}
