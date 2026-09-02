// New Task dispatch — the Planroom "+ New" backend.
//
// Orchestrates: company (optional inline create) → card → Notion task →
// handoff brief → interactive session via dispatch_spawn.sh (reused through
// runroom_build's spawnSession). Forgiving by design: each step records
// ok/detail and later steps still run where they can, so a Notion hiccup
// never costs the card. mode:"plan" stops after the card + Notion task —
// the frontend then triggers the card's Spark run through the existing
// /api/projects/:id/spark route so its concurrency guards stay in force.

import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import {
  createProject, getProjectById, updateProject,
  createCompany, getCompanyById, findSupervisorCard,
} from "./db.js";
import { createNotionTask } from "./notion.js";
import { resolveFreeSession, spawnSession } from "./runroom_build.js";

const HOME = process.env.HOME;
const HANDOFFS_DIR = resolve(HOME, "OpenDia", "handoffs");
const SESSION_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function etParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const offset = (parts.timeZoneName || "GMT-05:00").replace("GMT", "") || "-05:00";
  return { ...parts, offset };
}

// Due date anchored today 09:00 ET, same convention as /od-new.
function todayNineAmEt() {
  const p = etParts();
  return `${p.year}-${p.month}-${p.day}T09:00:00.000${p.offset}`;
}

// {company_short}-{task_first_word}, the /od-new & /dispatch convention.
// Fallback when the client didn't send an editable session name.
function deriveSessionName(companyShort, task) {
  const base = `${companyShort || "task"}-${(task || "").split(/\s+/)[0] || "new"}`;
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "new-task";
}

function buildBrief({ session, requesterEmail, project, company, notionUrl, task, context, supervisor }) {
  const p = etParts();
  const lines = [
    `# Handoff Brief — ${session}`,
    `- Created: ${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute} ET via dashboard + New (${requesterEmail})`,
    `- Client: ${company ? `${company.name} (${company.short_name})` : "none"}`,
    `- Division: ${project.division || "unset"}`,
    `- Card: #${project.id} — ${project.name}`,
    `- Notion: ${notionUrl || (project.notion_id ? `https://www.notion.so/${project.notion_id.replace(/-/g, "")}` : "none")}`,
    `- Estimate: set by /od-go on start`,
    "",
    "## Objective",
    task || project.name,
    "",
    "## Context",
    (context || "").trim() || "(none provided — read the card and Notion task)",
  ];
  if (supervisor) {
    lines.push(
      "",
      `**Supervisor:** this client is coordinated by the "${supervisor.name}" card ` +
      `(#${supervisor.id}${supervisor.tmux_session ? `, tmux session \`${supervisor.tmux_session}\`` : ""}). ` +
      "Coordinate significant decisions through it; do not duplicate its work."
    );
  }
  lines.push(
    "",
    "## First steps",
    `- [ ] Read card #${project.id} (notes, next_step) and the Notion task`,
    "- [ ] Plan the approach and confirm scope before changes",
    "",
    "## On start",
    `Run: /od-go ${project.id}`,
    ""
  );
  return lines.join("\n");
}

/**
 * The whole "+ New" flow. Returns { steps, projectId, sessionName, supervisor }.
 * Throws only on invalid input; runtime failures land in steps[] instead.
 */
export async function runDispatch(body, requesterEmail) {
  const { task, companyId, newCompany, existingProjectId, division, context, mode } = body || {};
  const steps = [];
  const record = (step, ok, detail) => steps.push({ step, ok, detail });

  if (!existingProjectId && !(task || "").trim()) throw new Error("task is required");
  if (mode && !["spawn", "plan"].includes(mode)) throw new Error(`invalid mode: ${mode}`);

  // 1. Company
  let company = null;
  if (newCompany?.name) {
    company = createCompany({ name: newCompany.name, shortName: newCompany.shortName });
    record("company", true, `#${company.id} ${company.name}`);
  } else if (companyId) {
    company = getCompanyById(companyId);
    if (!company) throw new Error(`unknown companyId: ${companyId}`);
  }

  // 2. Card
  let project;
  if (existingProjectId) {
    project = getProjectById(existingProjectId);
    if (!project) throw new Error(`unknown existingProjectId: ${existingProjectId}`);
    if (!company && project.company_id) company = getCompanyById(project.company_id);
    record("card", true, `using existing card #${project.id} — ${project.name}`);
  } else {
    project = createProject({
      name: task.trim(),
      companyName: company?.name || null,
      divisionName: division || null,
      status: "in_progress",
    });
    record("card", true, `created card #${project.id}`);
  }

  // 3. Notion task (skip when the card already has one — card ↔ task is 1:1).
  let notionUrl = null;
  if (project.notion_id) {
    record("notion", true, "card already linked to a Notion task — skipped");
  } else {
    const created = await createNotionTask({
      name: project.name,
      division: project.division || division || null,
      companyNotionId: company?.notion_id || null,
      requesterEmail,
      dueISO: todayNineAmEt(),
    });
    if (created) {
      updateProject(project.id, { notion_id: created.id });
      project = getProjectById(project.id);
      notionUrl = created.url;
      record("notion", true, created.url);
    } else {
      record("notion", false, "Notion task creation failed (token/API) — card is fine; link one later via the card");
    }
  }

  // 4. Supervisor check (authoritative source for the brief + response).
  const supervisor = findSupervisorCard(company?.id || project.company_id || null);

  if (mode === "plan") {
    record("mode", true, "plan-first: no session spawned; trigger Spark on the card");
    return { steps, projectId: project.id, sessionName: null, supervisor };
  }

  // 5-6. Brief + spawn.
  let finalName = null;
  try {
    let session = (body.sessionName || "").trim().toLowerCase();
    if (session && !SESSION_RE.test(session)) throw new Error(`invalid session name: ${session}`);
    if (!session) session = deriveSessionName(company?.short_name, task || project.name);
    // Resolve collisions BEFORE writing the brief so filename == session name.
    finalName = resolveFreeSession(session);
    mkdirSync(HANDOFFS_DIR, { recursive: true });
    const briefPath = resolve(HANDOFFS_DIR, `${finalName}.md`);
    writeFileSync(briefPath, buildBrief({
      session: finalName, requesterEmail, project, company, notionUrl,
      task: (task || "").trim(), context, supervisor,
    }));
    record("brief", true, briefPath);
    const spawned = spawnSession(finalName, briefPath);
    if (spawned && spawned !== finalName) finalName = spawned;
    updateProject(project.id, { tmux_session: finalName });
    record("spawn", true, finalName);
  } catch (err) {
    record(finalName ? "spawn" : "brief", false, err.message);
  }

  return { steps, projectId: project.id, sessionName: finalName, supervisor };
}
