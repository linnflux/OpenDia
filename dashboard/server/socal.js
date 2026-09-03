// SoCal admin view — thin bridge to repo/SoCal/socal_api.py so the sheets
// (source of truth) and the Meta token have exactly one implementation each.
// Reads are cached briefly; a successful patch invalidates the affected client.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const BRIDGE = path.join(os.homedir(), "OpenDia/repo/SoCal/socal_api.py");
const REGISTRY = path.join(os.homedir(), "OpenDia/socal-clients.json");
const TTL = { clients: 3 * 60_000, calendar: 3 * 60_000, analytics: 30 * 60_000 };

const cache = new Map(); // key -> { at, promise }

function bridge(args) {
  return new Promise((resolve, reject) => {
    execFile("python3", [BRIDGE, ...args], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.slice(-500) || err.message));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error("bridge returned non-JSON: " + stdout.slice(0, 200))); }
      });
  });
}

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

function findClient(slug) {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  return reg.find((c) => c.slug === slug);
}

export function mountSocal(app, requireAdmin) {
  app.get("/api/socal/clients", requireAdmin, async (_req, res) => {
    try { res.json(await cached("clients", TTL.clients, () => bridge(["clients"]))); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get("/api/socal/:slug/calendar", requireAdmin, async (req, res) => {
    const c = findClient(req.params.slug);
    if (!c) return res.status(404).json({ error: "unknown client" });
    try {
      res.json(await cached(`cal:${c.slug}`, TTL.calendar,
        () => bridge(["calendar", "--sheet", c.sheet])));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get("/api/socal/:slug/analytics", requireAdmin, async (req, res) => {
    const c = findClient(req.params.slug);
    if (!c) return res.status(404).json({ error: "unknown client" });
    if (!c.page_id) return res.json({ page: {}, fb_posts: [], ig_posts: [], note: "no Meta ids yet" });
    try {
      res.json(await cached(`an:${c.slug}`, TTL.analytics,
        () => bridge(["analytics", "--page", c.page_id, "--ig", c.ig_id || ""])));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // free-text instruction, carried out by a model instance that gets the post
  // row + client config as context and can only touch editable fields
  app.post("/api/socal/:slug/rows/:id/instruct", requireAdmin, async (req, res) => {
    const c = findClient(req.params.slug);
    if (!c) return res.status(404).json({ error: "unknown client" });
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "text required" });
    try {
      const out = await bridge(["instruct", "--sheet", c.sheet, "--id", req.params.id,
                                "--text", text, "--slug", c.slug]);
      if (out.error) return res.status(400).json(out);
      cache.delete(`cal:${c.slug}`);
      cache.delete("clients");
      res.json(out);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.patch("/api/socal/:slug/rows/:id", requireAdmin, async (req, res) => {
    const c = findClient(req.params.slug);
    if (!c) return res.status(404).json({ error: "unknown client" });
    const { field, value } = req.body || {};
    if (!field || value === undefined) return res.status(400).json({ error: "field and value required" });
    try {
      const out = await bridge(["patch", "--sheet", c.sheet, "--id", req.params.id,
                                "--field", String(field), "--value", String(value)]);
      if (out.error) return res.status(400).json(out);
      cache.delete(`cal:${c.slug}`);
      cache.delete("clients");
      res.json(out);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
}
