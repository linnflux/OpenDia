const ALLOWED_DOMAINS = (process.env.AUTH_ALLOWED_DOMAINS || "linnflux.com")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const ADMIN_EMAILS = (process.env.AUTH_ADMIN_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// cloudflared connects to us over loopback too, so a bare loopback socket is
// NOT proof of a local process. Cloudflare stamps these on everything it
// proxies; their presence means the request came from the public internet and
// must never inherit the local-process admin grant — even if the tunnel's
// ingress rules are ever widened beyond the webhook path.
const CF_PROXY_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-ipcountry", "cdn-loop", "x-forwarded-for"];

function viaPublicProxy(req) {
  return CF_PROXY_HEADERS.some((h) => req.headers[h]);
}

export function verifyRequest(req) {
  const login = (req.headers["tailscale-user-login"] || "").toLowerCase().trim();
  // Header present → came through tailscale serve; verify domain regardless of source IP.
  if (login) {
    const name = req.headers["tailscale-user-name"] || "";
    const domain = login.split("@")[1];
    if (!domain || !ALLOWED_DOMAINS.includes(domain)) return { ok: false, reason: "domain-not-allowed", login };
    return { ok: true, login, name, source: "tailscale", is_admin: ADMIN_EMAILS.includes(login) };
  }
  // No header → allow only genuinely local processes (/od-go, /od-stop, cron).
  if (isLoopback(req) && !viaPublicProxy(req)) {
    return { ok: true, login: "loopback", name: "Local Process", source: "loopback", is_admin: true };
  }
  return { ok: false, reason: "no-tailscale-header" };
}

export function requireLinnfluxUser(req, res, next) {
  const r = verifyRequest(req);
  if (!r.ok) return res.status(403).json({ error: "forbidden", reason: r.reason });
  req.user = r;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: "forbidden", reason: "admin_only" });
  }
  next();
}
