const ALLOWED_DOMAINS = (process.env.AUTH_ALLOWED_DOMAINS || "linnflux.com")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function verifyRequest(req) {
  const login = (req.headers["tailscale-user-login"] || "").toLowerCase().trim();
  // Header present → came through tailscale serve; verify domain regardless of source IP.
  if (login) {
    const name = req.headers["tailscale-user-name"] || "";
    const domain = login.split("@")[1];
    if (!domain || !ALLOWED_DOMAINS.includes(domain)) return { ok: false, reason: "domain-not-allowed", login };
    return { ok: true, login, name, source: "tailscale" };
  }
  // No header → allow only from loopback (local scripts: /od-go, /od-stop, etc.)
  if (isLoopback(req)) return { ok: true, login: "loopback", name: "Local Process", source: "loopback" };
  return { ok: false, reason: "no-tailscale-header" };
}

export function requireLinnfluxUser(req, res, next) {
  const r = verifyRequest(req);
  if (!r.ok) return res.status(403).json({ error: "forbidden", reason: r.reason });
  req.user = r;
  next();
}
