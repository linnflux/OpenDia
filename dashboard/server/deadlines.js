import { readFileSync } from "fs";
import { resolve } from "path";

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
