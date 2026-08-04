#!/usr/bin/env python3
"""OpenDia Rooms — a standing file-exchange daemon.

One long-lived server on one fixed port; each "room" is a directory exposed
at an unguessable subpath. The room page lists the directory's files for
download and (unless the room is read-only) accepts uploads into it. This
replaces the ad-hoc `python3 -m http.server` pattern, which had no registry
(the same directory ended up served on three ports at once), no upload
direction, and a habit of binding 0.0.0.0.

Bind posture: the Tailscale interface and loopback, never 0.0.0.0. The
management API (/api/rooms) answers loopback only — it reveals filesystem
paths, so tailnet peers get rooms, not the registry. The dashboard reaches
the API by proxying from Express with its own admin gate.

Registry persists to ~/OpenDia/rooms.json so rooms survive restarts. Rooms
live until closed (no TTL by design — the dashboard Rooms view is the
hygiene mechanism).
"""

import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opendia_config import get_id  # noqa: E402

PORT = int(get_id("ROOMS_PORT", default="9099"))
REGISTRY_PATH = Path.home() / "OpenDia" / "rooms.json"
MAX_UPLOAD = 500 * 1024 * 1024  # 500 MB

# Image rows get a server-generated thumbnail (made once, cached by
# content identity) so listing a room of phone photos costs kilobytes,
# not the megabytes the originals weigh. Needs Pillow; without it the
# page degrades to plain rows.
THUMB_CACHE = Path.home() / "OpenDia" / ".rooms-thumbs"
THUMB_EDGE = 160
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff"}
try:
    from PIL import Image  # noqa: F401
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

# Not a security boundary (the tailnet is trusted); this catches mistakes —
# an agent absent-mindedly opening a room on a credentials directory.
HOME = Path.home()
DENY_DIRS = [
    HOME,
    HOME / ".ssh",
    HOME / ".claude",
    HOME / ".gnupg",
    HOME / ".config",
    HOME / ".aws",
    HOME / "OpenDia",  # .opendia.conf and opendia.db live at its root
]

_lock = threading.Lock()
_rooms: dict[str, dict] = {}


# ── registry ─────────────────────────────────────────────────────────────

def load_registry():
    global _rooms
    try:
        data = json.loads(REGISTRY_PATH.read_text())
    except (OSError, ValueError):
        _rooms = {}
        return
    kept = {}
    for rid, room in data.items():
        if Path(room["dir"]).is_dir():
            kept[rid] = room
        else:
            print(f"dropping room {rid}: directory gone: {room['dir']}", flush=True)
    _rooms = kept
    if len(kept) != len(data):
        save_registry()


def save_registry():
    tmp = REGISTRY_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_rooms, indent=1))
    tmp.replace(REGISTRY_PATH)


def deny_reason(path: Path) -> str | None:
    resolved = path.resolve()
    for d in DENY_DIRS:
        if resolved == d.resolve():
            return f"refusing to open a room on {d} (sensitive directory)"
    for parent in (HOME / ".ssh", HOME / ".claude", HOME / ".gnupg",
                   HOME / ".config", HOME / ".aws"):
        if resolved.is_relative_to(parent.resolve()):
            return f"refusing to open a room under {parent}"
    try:
        for entry in resolved.iterdir():
            if entry.name == ".env" or entry.name.endswith(".env"):
                return f"directory contains {entry.name} — move secrets out first"
    except OSError:
        pass
    return None


# ── helpers ──────────────────────────────────────────────────────────────

def tailscale_self() -> dict:
    """{'ip4', 'ip6', 'dns_name'} — any may be None."""
    info = {"ip4": None, "ip6": None, "dns_name": None}
    try:
        out = subprocess.run(["tailscale", "status", "--json"],
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0:
            self_ = json.loads(out.stdout).get("Self", {})
            for ip in self_.get("TailscaleIPs") or []:
                if re.fullmatch(r"100\.\d+\.\d+\.\d+", ip):
                    info["ip4"] = ip
                elif ":" in ip:
                    info["ip6"] = ip
            dns = (self_.get("DNSName") or "").rstrip(".")
            if dns:
                info["dns_name"] = dns
    except Exception:
        pass
    if not info["ip4"]:
        # fallback: read the interface directly
        try:
            out = subprocess.run(["ip", "-4", "-o", "addr", "show", "tailscale0"],
                                 capture_output=True, text=True, timeout=5)
            m = re.search(r"inet (100\.\d+\.\d+\.\d+)", out.stdout)
            if m:
                info["ip4"] = m.group(1)
        except Exception:
            pass
    return info


# Resolved once at boot. URLs use the MagicDNS FQDN (opendia.tailXXXX.ts.net):
# it resolves via public DNS as well as MagicDNS, so it works in browsers with
# secure-DNS enabled and on devices without a MagicDNS search domain. The bare
# machine hostname does NOT — it resolves to 127.0.1.1 via /etc/hosts on this
# box and to nothing at all elsewhere, which shipped as "site can't be reached".
TS = tailscale_self()
URL_HOST = TS["dns_name"] or TS["ip4"] or "127.0.0.1"


def serve_https_port() -> int | None:
    """If `tailscale serve` proxies an HTTPS port to this daemon, prefer it in
    printed URLs — Tailscale terminates TLS with an auto-renewed ts.net cert,
    so HTTPS costs this daemon nothing. Probed at boot; if the serve config is
    ever removed, URLs revert to plain http on the next restart."""
    try:
        out = subprocess.run(["tailscale", "serve", "status", "--json"],
                             capture_output=True, text=True, timeout=5)
        if out.returncode != 0:
            return None
        cfg = json.loads(out.stdout or "{}")
        target = f"http://127.0.0.1:{PORT}"
        for hostport, site in (cfg.get("Web") or {}).items():
            for handler in (site.get("Handlers") or {}).values():
                if handler.get("Proxy") == target:
                    p = int(hostport.rsplit(":", 1)[-1])
                    if (cfg.get("TCP") or {}).get(str(p), {}).get("HTTPS"):
                        return p
    except Exception:
        pass
    return None


HTTPS_PORT = serve_https_port()


def room_url(rid: str) -> str:
    if HTTPS_PORT and TS["dns_name"]:
        port = "" if HTTPS_PORT == 443 else f":{HTTPS_PORT}"
        return f"https://{TS['dns_name']}{port}/r/{rid}/"
    return f"http://{URL_HOST}:{PORT}/r/{rid}/"


def list_files(room_dir: Path) -> list[dict]:
    files = []
    for entry in sorted(room_dir.iterdir(), key=lambda e: e.name.lower()):
        if entry.name.startswith(".") or not entry.is_file():
            continue  # top-level plain files only; no dotfiles, no subdirs
        st = entry.stat()
        files.append({"name": entry.name, "size": st.st_size,
                      "mtime": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")})
    return files


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n / 1:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def unique_name(room_dir: Path, name: str) -> str:
    """file.txt -> file-2.txt, file-3.txt... Never overwrite."""
    if not (room_dir / name).exists():
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    i = 2
    while True:
        candidate = f"{stem}-{i}.{ext}" if ext else f"{stem}-{i}"
        if not (room_dir / candidate).exists():
            return candidate
        i += 1


def is_image(name: str) -> bool:
    return Path(name).suffix.lower() in IMAGE_EXTS


def thumb_for(target: Path) -> Path | None:
    """Cached thumbnail path for an image, generating on first request.

    Cache key is path+mtime+size, so editing a file naturally invalidates
    its thumb. Returns None if Pillow is missing or the file won't decode.
    """
    if not HAVE_PIL:
        return None
    import hashlib
    st = target.stat()
    key = hashlib.sha1(f"{target}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()
    out = THUMB_CACHE / f"{key}.jpg"
    if out.exists():
        return out
    try:
        THUMB_CACHE.mkdir(parents=True, exist_ok=True)
        with Image.open(target) as im:
            im.thumbnail((THUMB_EDGE, THUMB_EDGE), Image.LANCZOS)
            # JPEG has no alpha; flatten onto dark grey so transparent PNGs
            # look intentional rather than garbled
            if im.mode not in ("RGB", "L"):
                from PIL import Image as _I
                bg = _I.new("RGB", im.size, (30, 34, 43))
                bg.paste(im, mask=im.convert("RGBA").getchannel("A"))
                im = bg
            tmp = out.with_suffix(".tmp")
            im.convert("RGB").save(tmp, "JPEG", quality=70, optimize=True)
            tmp.replace(out)
        return out
    except Exception as e:
        print(f"thumbnail failed for {target.name}: {e}", flush=True)
        return None


def prune_thumb_cache(max_age_days: int = 30):
    """Thumbs key on content identity, so stale entries only accumulate as
    files change or rooms close — a slow drip. Age them out at boot."""
    import time
    cutoff = time.time() - max_age_days * 86400
    try:
        for f in THUMB_CACHE.glob("*.jpg"):
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
    except OSError:
        pass


def sanitize_filename(name: str) -> str:
    # basename only, no dotfiles, printable, non-empty
    name = os.path.basename(name.replace("\\", "/")).strip()
    name = re.sub(r"[\x00-\x1f]", "", name)
    if not name or name.startswith("."):
        name = "upload-" + secrets.token_hex(3) + (Path(name).suffix if name else "")
    return name[:255]


# ── multipart (cgi is gone in 3.13; body is spooled to disk, parsed
#    from an mmap so a 500MB upload never lands in RAM) ──────────────────

def parse_multipart(spool_path: Path, boundary: bytes) -> list[tuple[str, Path]]:
    """Returns [(filename, temp_path)] for each file part."""
    import mmap
    results = []
    delim = b"--" + boundary
    with open(spool_path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        if size == 0:
            return results
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            pos = mm.find(delim)
            while pos != -1:
                part_start = pos + len(delim)
                if mm[part_start:part_start + 2] == b"--":
                    break  # closing delimiter
                # skip the CRLF after the boundary line
                if mm[part_start:part_start + 2] == b"\r\n":
                    part_start += 2
                header_end = mm.find(b"\r\n\r\n", part_start)
                if header_end == -1:
                    break
                headers = mm[part_start:header_end].decode("utf-8", "replace")
                body_start = header_end + 4
                nxt = mm.find(delim, body_start)
                if nxt == -1:
                    break
                body_end = nxt - 2 if mm[nxt - 2:nxt] == b"\r\n" else nxt
                m = re.search(r'filename="([^"]*)"', headers)
                if m and m.group(1):
                    tmp = tempfile.NamedTemporaryFile(delete=False, prefix="odroom-")
                    # write in chunks straight from the mmap; no big copy
                    CHUNK = 4 * 1024 * 1024
                    for off in range(body_start, body_end, CHUNK):
                        tmp.write(mm[off:min(off + CHUNK, body_end)])
                    tmp.close()
                    results.append((m.group(1), Path(tmp.name)))
                pos = nxt
        finally:
            mm.close()
    return results


# ── HTML ─────────────────────────────────────────────────────────────────

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><style>
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
 background:#0f172a;color:#e2e8f0;max-width:680px;margin:2rem auto;padding:0 1rem}}
h1{{font-size:1.1rem}} h1 small{{color:#64748b;font-weight:400;font-size:.8rem}}
table{{width:100%;border-collapse:collapse;margin:1rem 0}}
td,th{{padding:.45rem .5rem;border-bottom:1px solid #1e293b;text-align:left;font-size:.9rem}}
th{{color:#64748b;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}}
td.num{{text-align:right;color:#94a3b8;white-space:nowrap}}
td.th{{width:52px}} td.th img{{display:block;width:48px;height:36px;object-fit:cover;
 border-radius:4px;cursor:pointer;border:1px solid #1e293b}}
a{{color:#7dd3fc;text-decoration:none}} a:hover{{text-decoration:underline}}
form{{margin:1.25rem 0;padding:1rem;border:1px dashed #334155;border-radius:8px}}
input[type=file]{{color:#94a3b8}}
button{{background:#164e63;color:#22d3ee;border:none;border-radius:6px;
 padding:.45rem .9rem;cursor:pointer;font-size:.85rem}}
.empty{{color:#64748b;padding:1.5rem 0}} .msg{{color:#4ade80;font-size:.85rem}}
footer{{color:#475569;font-size:.72rem;margin-top:2rem}}
#lb{{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10;
 flex-direction:column;align-items:center;justify-content:center;gap:1rem;padding:1.5rem}}
#lb.open{{display:flex}}
#lb img{{max-width:92vw;max-height:80vh;border-radius:6px}}
#lb .bar{{display:flex;gap:.75rem;align-items:center}}
#lb .name{{color:#94a3b8;font-size:.85rem}}
#lb a.dl{{background:#164e63;color:#22d3ee;border-radius:6px;padding:.45rem .9rem}}
#lb button{{background:#1e293b;color:#94a3b8}}
</style></head><body>
<h1>{title} <small>OpenDia room</small></h1>
{msg}{table}{form}
<footer>Files live in this room until it is closed.</footer>
<div id="lb">
  <img id="lb-img" alt="">
  <div class="bar"><span class="name" id="lb-name"></span>
    <a class="dl" id="lb-dl" download>Download</a>
    <button onclick="lbClose()">Close</button></div>
</div>
<script>
var lb=document.getElementById('lb');
function lbOpen(name){{
  document.getElementById('lb-img').src=encodeURIComponent(name);
  document.getElementById('lb-name').textContent=name;
  document.getElementById('lb-dl').href=encodeURIComponent(name);
  lb.classList.add('open');
}}
function lbClose(){{lb.classList.remove('open');document.getElementById('lb-img').src='';}}
lb.addEventListener('click',function(e){{if(e.target===lb)lbClose();}});
document.addEventListener('keydown',function(e){{if(e.key==='Escape')lbClose();}});
</script>
</body></html>"""


def render_room(room: dict, msg: str = "") -> str:
    files = list_files(Path(room["dir"]))
    if files:
        rows = []
        for f in files:
            q = quote(f["name"])
            if HAVE_PIL and is_image(f["name"]):
                # data-name + JS keeps filenames out of inline handlers, so a
                # file named with quotes can't break out of the attribute
                thumb = (f'<img src="t/{q}" loading="lazy" alt="" '
                         f'data-name="{escape(f["name"], quote=True)}" '
                         f'onclick="lbOpen(this.dataset.name)">')
            else:
                thumb = ""
            rows.append(
                f'<tr><td class="th">{thumb}</td>'
                f'<td><a href="{q}" download>{escape(f["name"])}</a></td>'
                f'<td class="num">{human_size(f["size"])}</td>'
                f'<td class="num">{f["mtime"]}</td></tr>')
        table = (f'<table><tr><th></th><th>File</th><th style="text-align:right">Size</th>'
                 f'<th style="text-align:right">Modified (UTC)</th></tr>{"".join(rows)}</table>')
    else:
        table = '<div class="empty">No files here yet.</div>'
    form = ("" if room.get("read_only") else
            '<form method="post" action="upload" enctype="multipart/form-data">'
            '<input type="file" name="file" multiple> <button>Upload</button></form>')
    msg_html = f'<p class="msg">{escape(msg)}</p>' if msg else ""
    return PAGE.format(title=escape(room.get("name") or Path(room["dir"]).name),
                       msg=msg_html, table=table, form=form)


# ── request handler ──────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "OpenDiaRooms/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"{self.client_address[0]} {fmt % args}", flush=True)

    # Headers the tailscale-serve proxy stamps on everything it forwards
    # (verified by probing the live proxy). Their presence means the request
    # originated on the tailnet, not from a local process — even though the
    # proxy delivers it over loopback.
    PROXY_HEADERS = ("tailscale-user-login", "x-forwarded-for")

    def _is_local_process(self) -> bool:
        """True only for genuinely local callers (the CLI, the dashboard's
        Express proxy). The serve proxy connects from loopback too, so a bare
        source-address check would open the registry API — which reveals
        filesystem paths — to every tailnet member over the HTTPS port. Same
        trap and same fix as the dashboard's cloudflared handling in auth.js."""
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return False
        return not any(h in self.headers for h in self.PROXY_HEADERS)

    def _send(self, code: int, body: bytes, ctype: str = "text/html; charset=utf-8",
              extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj).encode(), "application/json")

    # ---- routing ----

    def do_GET(self):
        path = unquote(self.path.split("?")[0])
        if path == "/api/rooms":
            return self.api_list()
        m = re.fullmatch(r"/r/([A-Za-z0-9_-]+)/?", path)
        if m:
            return self.room_page(m.group(1))
        m = re.fullmatch(r"/r/([A-Za-z0-9_-]+)/t/([^/]+)", path)
        if m:
            return self.room_thumb(m.group(1), m.group(2))
        m = re.fullmatch(r"/r/([A-Za-z0-9_-]+)/([^/]+)", path)
        if m:
            return self.room_file(m.group(1), m.group(2))
        if path == "/":
            return self._send(200, b"OpenDia Rooms is running.", "text/plain")
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = unquote(self.path.split("?")[0])
        if path == "/api/rooms":
            return self.api_create()
        m = re.fullmatch(r"/r/([A-Za-z0-9_-]+)/upload", path)
        if m:
            return self.room_upload(m.group(1))
        self._send(404, b"not found", "text/plain")

    def do_DELETE(self):
        m = re.fullmatch(r"/api/rooms/([A-Za-z0-9_-]+)", unquote(self.path))
        if m:
            return self.api_close(m.group(1))
        self._send(404, b"not found", "text/plain")

    # ---- rooms (tailnet-facing) ----

    def _room_or_404(self, rid: str):
        with _lock:
            room = _rooms.get(rid)
        if not room or not Path(room["dir"]).is_dir():
            self._send(404, b"no such room", "text/plain")
            return None
        return room

    def room_page(self, rid: str):
        room = self._room_or_404(rid)
        if not room:
            return
        if not self.path.split("?")[0].endswith("/"):
            return self._send(301, b"", "text/plain", {"Location": f"/r/{rid}/"})
        msg = "Upload complete." if "uploaded=1" in self.path else ""
        self._send(200, render_room(room, msg).encode())

    def room_file(self, rid: str, name: str):
        room = self._room_or_404(rid)
        if not room:
            return
        if name.startswith(".") or "/" in name or "\\" in name:
            return self._send(404, b"not found", "text/plain")
        room_dir = Path(room["dir"]).resolve()
        target = (room_dir / name).resolve()
        if not target.is_relative_to(room_dir) or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        size = target.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(target, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def room_thumb(self, rid: str, name: str):
        room = self._room_or_404(rid)
        if not room:
            return
        if name.startswith(".") or "/" in name or "\\" in name or not is_image(name):
            return self._send(404, b"not found", "text/plain")
        room_dir = Path(room["dir"]).resolve()
        target = (room_dir / name).resolve()
        if not target.is_relative_to(room_dir) or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        thumb = thumb_for(target)
        if not thumb:
            return self._send(404, b"no thumbnail", "text/plain")
        body = thumb.read_bytes()
        # content-keyed cache name means the thumb for this URL never changes
        # without the file itself changing, so long client caching is safe
        self._send(200, body, "image/jpeg",
                   {"Cache-Control": "max-age=86400"})

    def room_upload(self, rid: str):
        room = self._room_or_404(rid)
        if not room:
            return
        if room.get("read_only"):
            return self._send(403, b"this room is read-only", "text/plain")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._send(400, b"empty upload", "text/plain")
        if length > MAX_UPLOAD:
            return self._send(413, b"upload exceeds 500MB cap", "text/plain")
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r"boundary=([^\s;]+)", ctype)
        if not m:
            return self._send(400, b"expected multipart/form-data", "text/plain")
        boundary = m.group(1).strip('"').encode()

        # spool the body to disk in chunks — never hold it in RAM
        spool = tempfile.NamedTemporaryFile(delete=False, prefix="odroom-body-")
        try:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                spool.write(chunk)
                remaining -= len(chunk)
            spool.close()
            parts = parse_multipart(Path(spool.name), boundary)
            if not parts:
                return self._send(400, b"no file in upload", "text/plain")
            room_dir = Path(room["dir"])
            saved = []
            for orig_name, tmp_path in parts:
                final = unique_name(room_dir, sanitize_filename(orig_name))
                shutil.move(str(tmp_path), str(room_dir / final))
                saved.append(final)
            print(f"room {rid}: uploaded {', '.join(saved)}", flush=True)
        finally:
            for p in (Path(spool.name),):
                p.unlink(missing_ok=True)
        # redirect back to the room page (browser form); curl sees 303 + location
        self._send(303, b"", "text/plain", {"Location": f"/r/{rid}/?uploaded=1"})

    # ---- management API (loopback only) ----

    def api_list(self):
        if not self._is_local_process():
            return self._json(403, {"error": "loopback only"})
        with _lock:
            rooms = []
            for rid, room in _rooms.items():
                d = Path(room["dir"])
                rooms.append({**room, "url": room_url(rid),
                              "files": len(list_files(d)) if d.is_dir() else 0})
        self._json(200, sorted(rooms, key=lambda r: r["created"]))

    def api_create(self):
        if not self._is_local_process():
            return self._json(403, {"error": "loopback only"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": "bad json"})
        raw = body.get("dir", "")
        if not raw:
            return self._json(400, {"error": "dir required"})
        room_dir = Path(raw).expanduser().resolve()
        if not room_dir.is_dir():
            return self._json(400, {"error": f"not a directory: {room_dir}"})
        reason = deny_reason(room_dir)
        if reason:
            return self._json(403, {"error": reason})
        with _lock:
            for rid, room in _rooms.items():
                if Path(room["dir"]).resolve() == room_dir:
                    # the whole point of the registry: never serve one dir twice
                    return self._json(200, {**room, "url": room_url(rid), "existing": True})
            rid = secrets.token_urlsafe(6).replace("-", "a").replace("_", "b")
            room = {"id": rid, "dir": str(room_dir),
                    "name": body.get("name") or room_dir.name,
                    "read_only": bool(body.get("read_only")),
                    "created": datetime.now(tz=timezone.utc).isoformat(timespec="seconds")}
            _rooms[rid] = room
            save_registry()
        print(f"opened room {rid} on {room_dir}", flush=True)
        self._json(201, {**room, "url": room_url(rid)})

    def api_close(self, rid: str):
        if not self._is_local_process():
            return self._json(403, {"error": "loopback only"})
        with _lock:
            room = _rooms.pop(rid, None)
            if room:
                save_registry()
        if not room:
            return self._json(404, {"error": "no such room"})
        print(f"closed room {rid} ({room['dir']})", flush=True)
        self._json(200, {"closed": rid})


# ── main ─────────────────────────────────────────────────────────────────

class ThreadingHTTPServer6(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def serve_on(host: str):
    cls = ThreadingHTTPServer6 if ":" in host else ThreadingHTTPServer
    srv = cls((host, PORT), Handler)
    print(f"listening on {host}:{PORT}", flush=True)
    srv.serve_forever()


def main():
    load_registry()
    prune_thumb_cache()
    print(f"loaded {len(_rooms)} room(s) from {REGISTRY_PATH}", flush=True)
    print(f"room URLs use host: {URL_HOST}", flush=True)
    if not HAVE_PIL:
        print("NOTE: Pillow not installed — image thumbnails disabled", flush=True)
    hosts = ["127.0.0.1"]
    if TS["ip4"]:
        hosts.append(TS["ip4"])
    else:
        print("WARNING: no tailscale IP found — rooms reachable from this "
              "machine only", flush=True)
    # The ts.net name can resolve to AAAA on some resolvers; answer there too
    # or a v6-preferring browser sees connection refused.
    if TS["ip6"]:
        hosts.append(TS["ip6"])
    threads = [threading.Thread(target=serve_on, args=(h,), daemon=True) for h in hosts]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
