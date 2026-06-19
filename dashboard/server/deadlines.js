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
