import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import express from "express";
import {
  gateForSession, captureLiveTail, deliver as sendToSession, firstNameOf,
  MAX_SEND_CHARS, sessionPlanFile, PLANS_DIR,
} from "./session_gate.js";

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
//
// The modal gate (gateForSession/captureLiveTail/deliver/firstNameOf) lives
// in session_gate.js — extracted so mailroom.js can bind to a different
// standing session over the same tmux-send/sends.log machinery.

const RUNROOMS_DIR = resolve(process.env.HOME, "OpenDia", "runrooms");

// One room per tmux session; session names come from tmux via od-go/dispatch
// and are pathless slugs. Reject anything else so a crafted :session can
// never traverse out of RUNROOMS_DIR.
const SESSION_RE = /^[A-Za-z0-9._-]+$/;

// Last write to a session's plan.json — the room's staleness signal. A live
// session that isn't updating the file and a dead one look identical without
// this; surfacing the age lets the page say which story it's telling.
function planMtime(session) {
  try {
    return statSync(resolve(RUNROOMS_DIR, session, "plan.json")).mtimeMs;
  } catch {
    return null;
  }
}

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

// Thin wrapper over session_gate.js's deliver(): a runroom's sends.log lives
// under RUNROOMS_DIR/<session>/, keyed by the plan's directory (which can in
// principle differ from the live tmux target after a relocatePlan) — that
// path-building is runrooms-specific, so it stays here rather than in the
// shared module.
function deliver(session, plan, text, user, tag) {
  return sendToSession({
    tmuxSession: plan.tmux_session,
    logPath: resolve(RUNROOMS_DIR, session, "sends.log"),
    text, user, tag,
  });
}

// The action protocol. Canned messages live HERE, not in the client, so the
// contract between button and session has exactly one author. Every message
// leads with [runroom] so the session knows the operator is speaking through
// the room, and every one restates the contract obligation it triggers —
// the UI's response to a click comes back through plan.json, not through an
// API side effect.
const ACTIONS = {
  opendia_do: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): do it yourself now, OpenDia. If the step's actor is "either", set it to "opendia" in plan.json first. Keep plan.json current as you work — file before prose.`,
  human_do: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): ${name} will do this by hand. Set the step's actor to "human" in plan.json and rewrite its detail as a walk-through — SHORT, the pane renders large type: a sentence or two per instruction, copyable commands in fenced code blocks, destructive ones behind a "> ⚠" line, never a secret — then wait for the runroom to report back.`,
  human_done: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): ${name} reports it finished. If a cheap check exists (file exists, DNS resolves, HTTP 200), run it before believing it. Then update plan.json: state "done" — or "failed" with the evidence in the step's note — advance current_step, and prepare the next step's detail.`,
  human_failed: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): ${name} reports it FAILED. Set state "failed" and record what is known in the step's note. Ask for or gather the error, then write next-move guidance into the step's detail — and if the plan needs restructuring, follow the contract's drift rule.`,
  skip: (n, t, name) =>
    `[runroom] Step ${n} ("${t}"): ${name} says skip it. Set state "skipped" with the reason in the step's note, advance current_step, and prepare the next step's detail.`,
};

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
      .map(({ session, plan }) => {
        // One gate read per active room per poll — local and cheap at the
        // 1-3 rooms this list carries. It answers the list's real question:
        // is this room thinking (leave it alone) or waiting on the operator
        // (go back in)?  working = mid-turn; needs = why it's waiting:
        // "dialog" (a decision is on screen), "input" (idle, your move), or
        // "gone" (the tmux session died under an active room).
        let working = false, needs = null;
        if (plan.status === "active") {
          const g = gateForSession(plan.tmux_session);
          working = !!g?.working;
          if (!working) {
            needs = g?.reason === "dialog-open" ? "dialog"
              : g?.reason === "session-gone" ? "gone" : "input";
          }
        }
        return {
          session,
          plan_mtime: planMtime(session),
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
          working,
          needs,
        };
      })
      // Active rooms first; within active, rooms waiting on the operator
      // outrank rooms that are busy thinking; newest first as the tiebreak.
      .sort((a, b) =>
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1)
        || (a.needs ? 0 : 1) - (b.needs ? 0 : 1)
        || (b.created || "").localeCompare(a.created || ""));
    res.json(rooms);
  });

  app.get("/api/runrooms/:session", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    // Piggyback the gate on the poll the page already makes, so the composer
    // can disable itself the moment a dialog opens — before a send bounces.
    const gate = plan.status === "active" ? gateForSession(plan.tmux_session) : { ok: false, reason: plan.status };
    // A plan-approval dialog gets the real plan document: the pane can only
    // ever show one page of it, the file holds all of it.
    if (gate.dialog?.options?.some((o) => /approve/i.test(o.label))) {
      const found = sessionPlanFile(plan.tmux_session, plan.created);
      if (found) {
        try {
          gate.dialog.plan_file = found.name;
          gate.dialog.plan_md = readFileSync(resolve(PLANS_DIR, found.name), "utf8").slice(0, 60_000);
        } catch {}
      }
    }
    // sends_mtime lets the page catch a quieter drift than the working-strip
    // case: the operator has said things (or clicked actions) since the plan
    // file last moved — the session acted without keeping the room current.
    let sendsMtime = null;
    try { sendsMtime = statSync(resolve(RUNROOMS_DIR, session, "sends.log")).mtimeMs; } catch {}
    // The ticker exists only while the session is mid-turn: when the turn
    // ends the room's real content (dialog, steps, announcement) takes over
    // and the passing output has served its purpose.
    const live = plan.status === "active" && gate.working
      ? captureLiveTail(plan.tmux_session) : null;
    res.json({
      ...plan,
      plan_mtime: planMtime(session),
      sends_mtime: sendsMtime,
      ...(live ? { live_output: live } : {}),
      gate,
    });
  });

  app.post("/api/runrooms/:session/send", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });

    let text = typeof req.body?.text === "string" ? req.body.text : "";
    // Literal text only: keep newlines (they insert, not submit, in the TUI
    // input box), strip every other control character so nothing can smuggle
    // key sequences, and cap the size.
    text = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
    if (!text) return res.status(400).json({ error: "empty message" });
    if (text.length > MAX_SEND_CHARS) return res.status(400).json({ error: `over ${MAX_SEND_CHARS} chars` });

    // Gate is re-checked inside deliver() at send time, not just at poll
    // time — the screen may have changed in the seconds since the composer
    // last looked. (-l literal, args array, no shell.)
    const { status, body } = deliver(session, plan, text, req.user, null);
    res.status(status).json(body);
  });

  app.post("/api/runrooms/:session/action", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });

    const { action, step } = req.body || {};
    const make = ACTIONS[action];
    if (!make) return res.status(400).json({ error: "unknown action" });
    // Buttons act on the CURRENT step only. A stale page (plan advanced since
    // its last poll) gets a conflict, not a mis-aimed instruction.
    if (Number(step) !== Number(plan.current_step)) {
      return res.status(409).json({ error: "stale step", current_step: plan.current_step });
    }
    const s = (plan.steps || []).find((x) => Number(x.n) === Number(step));
    if (!s) return res.status(400).json({ error: "no such step" });

    const text = make(s.n, s.title, firstNameOf(req.user));
    const { status, body } = deliver(session, plan, text, req.user, action);
    res.status(status).json(body);
  });

  // Close the room outright — the work is finished or moot. Room-scoped, so
  // it does not go through the step-stale check above. With a live session
  // this stays inside the single-writer contract: a canned message asks the
  // session to close its own file. When the session is GONE the contract has
  // no writer left, and a room stuck "active" forever is the worse corruption
  // — so for that one case this route becomes the writer of last resort.
  app.post("/api/runrooms/:session/close", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });
    const note = String(req.body?.note || "").trim().slice(0, 500);
    const who = firstNameOf(req.user);

    const gate = gateForSession(plan.tmux_session);
    if (gate.reason === "session-gone") {
      const allDone = (plan.steps || []).length > 0
        && plan.steps.every((s) => ["done", "skipped"].includes(s.state));
      plan.status = allDone ? "completed" : "abandoned";
      plan.note = `Closed by ${who} after the session died${note ? ` — ${note}` : "."}`;
      plan.updated = new Date().toISOString();
      try {
        writeFileSync(resolve(RUNROOMS_DIR, session, "plan.json"), JSON.stringify(plan, null, 2));
      } catch (e) {
        return res.status(500).json({ error: `close failed: ${e.message}` });
      }
      try {
        appendFileSync(resolve(RUNROOMS_DIR, session, "sends.log"),
          `${new Date().toISOString()} ${req.user?.login || "?"} [close]: server wrote status=${plan.status} (session gone)\n`);
      } catch {}
      return res.json({ ok: true, status: plan.status, wrote: "server" });
    }

    const text = `[runroom] ${who} says this run is finished — the work is done or moot${note ? ` (${note})` : ""}. Verify nothing is half-applied, set each remaining step "done" or "skipped" with a one-line note, set status "completed" (or "abandoned" if the work is moot), and close out per the contract.`;
    const { status, body } = deliver(session, plan, text, req.user, "close");
    res.status(status).json(status === 200 ? { ...body, wrote: "session" } : body);
  });

  // A pasted image. The session needs no special channel to receive one —
  // it needs a file path and a nudge to Read it (the Read tool renders
  // images). Raw body, not JSON: the global express.json 1MB limit would
  // choke screenshots, but it only parses application/json, so image/*
  // bypasses it entirely and lands in this route's own raw parser.
  const IMAGE_MAGIC = [
    { ext: "png",  test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { ext: "jpg",  test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: "gif",  test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
    { ext: "webp", test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                              && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  ];

  app.post("/api/runrooms/:session/image",
    express.raw({ type: "image/*", limit: "15mb" }),
    (req, res) => {
      const { session } = req.params;
      if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
      const plan = readPlan(session);
      if (!plan) return res.status(404).json({ error: "no such runroom" });
      if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });

      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length < 16) return res.status(400).json({ error: "no image body" });
      // Sniff the magic bytes; the client's Content-Type and any filename are
      // untrusted. The extension comes from what the bytes actually are.
      const kind = IMAGE_MAGIC.find((m) => m.test(buf));
      if (!kind) return res.status(400).json({ error: "not a recognized image (png/jpg/gif/webp)" });

      // Fail fast while the gate is closed — the attachment stays pending in
      // the client rather than orphaning a file here.
      const pre = gateForSession(plan.tmux_session);
      if (!pre.ok) return res.status(409).json({ error: "gate closed", gate: pre });

      let caption = typeof req.query.caption === "string" ? req.query.caption : "";
      caption = caption.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);

      const dir = resolve(RUNROOMS_DIR, session, "uploads");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const path = resolve(dir, `${stamp}.${kind.ext}`);
      try {
        writeFileSync(path, buf);
      } catch (e) {
        return res.status(500).json({ error: `save failed: ${e.message}` });
      }

      const name = firstNameOf(req.user);
      const text = `[runroom] ${name} pasted an image${caption ? ` — "${caption}"` : ""}: ${path} (open it with Read)`;
      const { status, body } = deliver(session, plan, text, req.user, "image");
      // deliver() re-gates; if the screen changed between the pre-check and
      // now, don't leave an orphan the session was never told about.
      if (status !== 200) { try { unlinkSync(path); } catch {} }
      res.status(status).json(status === 200 ? { sent: true, path } : body);
    });

  // Answer the dialog the session is currently showing. The one write that is
  // ALLOWED while the gate is closed — it exists precisely because the gate
  // is closed. Digits select immediately in the TUI's dialogs; Enter confirms
  // a multi-select; Escape cancels.
  app.post("/api/runrooms/:session/dialog", (req, res) => {
    const { session } = req.params;
    if (!SESSION_RE.test(session)) return res.status(400).json({ error: "bad session name" });
    const plan = readPlan(session);
    if (!plan) return res.status(404).json({ error: "no such runroom" });
    if (plan.status !== "active") return res.status(409).json({ error: "runroom is not active" });

    const { choice, fingerprint } = req.body || {};
    // Navigation keys exist for form-style dialogs: checkbox multiselects
    // toggle with Enter and move with arrows (number keys are inert there),
    // and the multi-question variant walks its parts with ←/→ ending on
    // Submit — the room must be able to drive all of it.
    if (!/^([1-9]|enter|esc|up|down|left|right|space)$/.test(String(choice))) {
      return res.status(400).json({ error: "bad choice" });
    }
    const isNav = !/^[1-9]$/.test(String(choice));

    // Re-read the screen at answer time. The dialog must still be up, must
    // still parse, and must be the SAME dialog the operator saw — a changed
    // fingerprint means their click was aimed at something that is gone.
    // Navigation keys are exempt from the fingerprint match: in a checkbox
    // form every toggle rewrites the labels ("[ ]"→"[✔]") and thus the
    // fingerprint, which turned the operator's second click into a stale
    // rejection loop. Arrows/space/enter/esc are safe against any dialog.
    const gate = gateForSession(plan.tmux_session);
    if (gate.reason !== "dialog-open" || !gate.dialog) {
      return res.status(409).json({ error: "no dialog on screen", gate });
    }
    if (!isNav && (!fingerprint || fingerprint !== gate.dialog.fingerprint)) {
      return res.status(409).json({ error: "dialog changed", gate });
    }
    if (/^[1-9]$/.test(String(choice)) &&
        !gate.dialog.options.some((o) => o.n === Number(choice))) {
      return res.status(400).json({ error: "no such option", gate });
    }

    const KEYMAP = { esc: "Escape", enter: "Enter", up: "Up", down: "Down", left: "Left", right: "Right", space: "Space" };
    const key = KEYMAP[choice] || String(choice);
    try {
      execFileSync("tmux", ["send-keys", "-t", plan.tmux_session, key], { timeout: 3000 });
    } catch (e) {
      return res.status(502).json({ error: `send failed: ${e.message}` });
    }
    try {
      const label = choice === "esc" || choice === "enter" ? choice
        : gate.dialog.options.find((o) => o.n === Number(choice))?.label;
      appendFileSync(resolve(RUNROOMS_DIR, session, "sends.log"),
        `${new Date().toISOString()} ${req.user?.login || "?"} [dialog]: ${choice} (${label})\n`);
    } catch {}
    res.json({ answered: true });
  });
}
