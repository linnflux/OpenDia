// planrooms.js — read API over the standing plans, plus the one write that
// turns a plan into a room.
//
// Mirrors runrooms.js: this module never writes a plan itself. Reads come from
// planroom_build.js; the adopt route delegates to spark.js's openRunroom, which
// is the single function that moves a plan into a runroom (from a live run or
// from the standing plan — same code, same timer ordering).
//
// Base auth only, like runrooms: the plan is the operator's window into a card.
// Decisions are admin-gated where they already are — the spark routes and the
// adopt route below.

import { existsSync, readFileSync, statSync } from "fs";

import { requireAdmin } from "./auth.js";
import { getProjectById } from "./db.js";
import { listPlanrooms, readPlanroom } from "./planroom_build.js";
import { RUNROOM_ROOT } from "./runroom_build.js";
import { getSparkRun, publicRun, openRunroom } from "./spark.js";

const LIVE_STATUSES = new Set(["in_progress", "wfhuman"]);
const STALE_DAYS = 7;
// Mirrors spark.js so both surfaces agree on one number.
const LOW_CERTITUDE = 60;

/**
 * The runroom a pointer names, if it still exists for this card. The planroom
 * page renders THESE steps while adopted — one source of truth, the runroom
 * file the session owns — and falls back to its own snapshot otherwise.
 */
function readThrough(plan) {
  const session = plan?.adopted_by?.tmux_session;
  if (!session) return null;
  const file = `${RUNROOM_ROOT}/${session}/plan.json`;
  try {
    const rr = JSON.parse(readFileSync(file, "utf8"));
    if (rr.card_id !== plan.card_id) return null;
    let plan_mtime = null;
    try { plan_mtime = statSync(file).mtimeMs; } catch {}
    return {
      session,
      status: rr.status,
      current_step: rr.current_step,
      steps: rr.steps || [],
      title: rr.title,
      plan_mtime,
    };
  } catch {
    return null;
  }
}

function visibleTo(req, project) {
  if (!project) return false;
  if (project.tmux_session === "operator" && !req.user?.is_admin) return false;
  return true;
}

export function registerPlanroomRoutes(app) {
  // One item per card that has a plan. Default view is the working set:
  // live cards, sparked within a week. ODA sweeps will populate dozens of
  // cards, so the list filters rather than the reader.
  app.get("/api/planrooms", (req, res) => {
    const all = req.query.all === "1";
    const cutoff = Date.now() - STALE_DAYS * 86400000;
    const items = [];
    for (const { cardId, plan, mtime } of listPlanrooms()) {
      const project = getProjectById(cardId);
      if (!visibleTo(req, project)) continue;
      const live = getSparkRun(cardId);
      const isLive = !!live && !live.finishedAt;
      const stale = mtime < cutoff;
      if (!all) {
        if (!LIVE_STATUSES.has(project.status)) continue;
        if (stale && !isLive && plan.status !== "adopted") continue;
      }
      const steps = plan.steps || [];
      const rr = plan.status === "adopted" ? readThrough(plan) : null;
      items.push({
        card_id: cardId,
        card_name: project.name,
        company: project.company_name || plan.company || "",
        division: project.division || plan.division || "",
        project_status: project.status,
        title: plan.title,
        status: plan.status,
        certitude: plan.planroom?.certitude?.pct ?? null,
        route: plan.planroom?.route || null,
        sparked_at: plan.planroom?.sparked_at || plan.created,
        sparked_by: plan.planroom?.sparked_by || "",
        updated: plan.updated || plan.created,
        adopted_by: plan.adopted_by || null,
        runroom_status: rr?.status || null,
        steps_total: (rr?.steps || steps).length,
        steps_done: (rr?.steps || steps).filter((s) => s.state === "done").length,
        live: isLive ? { status: live.status, startedBy: live.startedBy || "" } : null,
        stale,
      });
    }
    // Needs a decision first, then freshest active, then adopted.
    const rank = (x) => (x.live?.status === "proposing" ? 0 : x.live ? 1 : x.status === "adopted" ? 3 : 2);
    items.sort((a, b) => rank(a) - rank(b) || String(b.sparked_at).localeCompare(String(a.sparked_at)));
    res.json(items);
  });

  app.get("/api/planrooms/:cardId", (req, res) => {
    const cardId = parseInt(req.params.cardId, 10);
    const project = getProjectById(cardId);
    if (!visibleTo(req, project)) return res.status(404).json({ error: "card not found" });
    const plan = readPlanroom(cardId);
    const live = getSparkRun(cardId);
    // The open step as a single object — every client would otherwise hunt
    // steps[] for current_step. Lives in the planroom block with the report.
    if (plan?.planroom) {
      const open = plan.current_step != null ? (plan.steps || []).find((s) => s.n === plan.current_step) : null;
      plan.planroom.step = open
        ? { text: open.title, why: (open.detail || "").split("\n\n")[0] || null, route: plan.planroom.route }
        : null;
      plan.planroom.note = plan.note || null;
      plan.planroom.adopted = plan.status === "adopted";
    }
    // A card with no plan yet is a valid planroom: empty, with a Spark button.
    res.json({
      card: {
        id: project.id, name: project.name, company_name: project.company_name,
        division: project.division, status: project.status, tmux_session: project.tmux_session,
        next_step: project.next_step,
      },
      plan: plan || null,
      runroom: plan ? readThrough(plan) : null,
      run: publicRun(live),
      lowCertitude: LOW_CERTITUDE,
      canStart: !!req.user?.is_admin,
    });
  });

  // Open a runroom from the STANDING plan, no live run required. This is what
  // makes a plan "standing": come back tomorrow and hand it to a session
  // without re-sparking. openRunroom handles a null run.
  app.post("/api/planrooms/:cardId/adopt", requireAdmin, async (req, res) => {
    const cardId = parseInt(req.params.cardId, 10);
    const project = getProjectById(cardId);
    if (!visibleTo(req, project)) return res.status(404).json({ error: "card not found" });
    const live = getSparkRun(cardId);
    if (live && !live.finishedAt && live.status !== "proposing") {
      return res.status(409).json({ error: `a spark is ${live.status} on this card — wait for it` });
    }
    try {
      // A proposing run adopts through its own decide route so its timer
      // closes in order; with nothing live, the standing plan is adopted.
      const room = await openRunroom(project, live && !live.finishedAt ? live : null);
      res.json({ ok: true, ...room });
    } catch (err) {
      console.error("planroom: adopt failed:", err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
