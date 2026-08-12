import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

// Runrooms — read-only API over ~/OpenDia/runrooms/<tmux-session>/plan.json.
//
// The files are written and maintained by the Claude session that owns the
// plan (the /runroom skill's standing contract: file before prose), so this
// module never writes. There is deliberately no registry: the directory IS
// the registry, exactly one live plan.json per session, which leaves nothing
// to drift out of sync after a crash.
//
// Base auth only (requireLinnfluxUser, applied app-wide) — runrooms are work
// instructions for whichever operator is walking the plan, so unlike Rooms
// they must be visible to non-admins.

const RUNROOMS_DIR = resolve(process.env.HOME, "OpenDia", "runrooms");

// One room per tmux session; session names come from tmux via od-go/dispatch
// and are pathless slugs. Reject anything else so a crafted :session can
// never traverse out of RUNROOMS_DIR.
const SESSION_RE = /^[A-Za-z0-9._-]+$/;

function readPlan(session) {
  const p = resolve(RUNROOMS_DIR, session, "plan.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // A half-written file (the session updates it in place) is a transient
    // state, not an error worth surfacing; the next poll gets the full write.
    return null;
  }
}

export function registerRunroomRoutes(app) {
  app.get("/api/runrooms", (_req, res) => {
    let sessions = [];
    try {
      sessions = readdirSync(RUNROOMS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return res.json([]); // no runrooms dir yet — an empty list, not a 500
    }
    const rooms = sessions
      .map((s) => ({ session: s, plan: readPlan(s) }))
      .filter((r) => r.plan)
      .map(({ session, plan }) => ({
        session,
        title: plan.title,
        status: plan.status,
        card_id: plan.card_id,
        card_name: plan.card_name,
        company: plan.company,
        division: plan.division,
        created: plan.created,
        current_step: plan.current_step,
        steps_total: (plan.steps || []).length,
        steps_done: (plan.steps || []).filter((s) => s.state === "done").length,
      }))
      // Active rooms first, newest first within each group.
      .sort((a, b) =>
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1)
        || (b.created || "").localeCompare(a.created || ""));
    res.json(rooms);
  });

  app.get("/api/runrooms/:session", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    res.json(plan);
  });
}
