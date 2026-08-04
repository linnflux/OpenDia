# Rooms — standing file exchange over the tailnet

One long-lived daemon on one fixed port. A **room** is a directory exposed at
an unguessable subpath: the page lists the directory's files for download and
(unless the room is read-only) accepts uploads into it. Rooms replace the
ad-hoc `python3 -m http.server` pattern, which had no registry (the same
directory ended up served on three ports at once), no upload direction, and a
habit of binding `0.0.0.0`.

## Usage

```
od-room open <dir> [--read-only] [--name "<Client> <Content>"]  # → https://<host>.ts.net:9443/r/<id>/
od-room list
od-room close <id|all>       # 'all' lists what it would close and confirms
```

`open` on a directory that already has a room returns the existing URL —
one directory, one room, always — and re-opening with `--name` renames the
room in place without changing its URL. Name rooms for the human reading
the dashboard list: `"<Client> <Content>"` ("Acme Videos"), never the bare
directory name. URLs use the machine's MagicDNS FQDN
(`<machine>.tailXXXX.ts.net`), which resolves via public DNS as well as
MagicDNS — so they work in browsers with secure-DNS enabled and on
devices without a MagicDNS search domain. Agents cleaning up after
themselves should close by id; `close all` requires confirmation (or
`--yes`) because the registry is shared across every session.

Rooms have **no TTL**: they live until closed. The admin **Rooms** view in the
dashboard (sidebar → ADMIN) lists every open room with a copy-URL button and a
Close button; that view is the hygiene mechanism.

## Architecture

- `scripts/rooms_daemon.py` — stdlib-only Python daemon, run by the
  `opendia-rooms` systemd user unit. Port from `ROOMS_PORT` in
  `~/OpenDia/.opendia.conf` (default 9099).
- Binds the **Tailscale IP and loopback only** — never `0.0.0.0`. If no
  Tailscale interface is found it warns and serves loopback only.
- Registry persists to `~/OpenDia/rooms.json`; rooms survive daemon restarts.
  Rooms whose directory has vanished are dropped at boot.
- Room ids come from `secrets.token_urlsafe` — unguessable, which is the
  intended level of protection inside a trusted tailnet.
- The management API (`/api/rooms` CRUD) answers **loopback only**, because it
  reveals filesystem paths. The dashboard proxies it through Express with
  `requireAdmin`; the CLI talks to it directly (loopback is implicitly
  trusted, matching the dashboard's own auth model).

## Behaviour details

- Listing shows top-level plain files only — no dotfiles, no subdirectories.
- Image and video rows carry a server-generated thumbnail (images need
  Pillow, videos need ffmpeg; either degrades to plain rows if missing).
  Thumbs are built once per content identity (path+mtime+size), cached under
  `~/OpenDia/.rooms-thumbs/`, pruned after 30 days at daemon boot, and served
  with a day of client caching — a 2 MB photo costs ~1 KB per listing.
  Clicking a thumbnail opens an in-page lightbox with a download button;
  video thumbnails (marked with a play badge) open an HTML5 player instead.
  The originals are only fetched on open.
- File serving honors single-byte-range requests (RFC 9110, 206/416) —
  required for the video seek bar to work. Playable set: mp4/webm/mov/m4v;
  other containers stay download-only.
- Every room page carries the OpenDia mark + "Rooms" header, served from the
  dashboard's own SVG at `/assets/mark.svg`; text-only if the file is absent.
- Uploads: multipart, 500 MB cap, spooled to disk (never held in RAM),
  filename sanitised to a basename, collisions renamed `file-2.ext` — an
  upload can never overwrite an existing file.
- Path traversal is rejected at three layers (URL shape, dotfile check,
  resolved-path prefix check).
- The daemon refuses to open rooms on obviously sensitive paths (`~` itself,
  `~/.ssh`, `~/.claude`, `~/.config`, `~/.aws`, `~/.gnupg`, `~/OpenDia` root)
  or any directory containing a `.env` file. This is a mistake-catcher, not a
  security boundary — the tailnet is trusted.

## HTTPS

Rooms are served over HTTPS via `tailscale serve`, which terminates TLS with
an auto-provisioned, auto-renewed Let's Encrypt cert for the machine's ts.net
name — the daemon itself never touches certificates:

```
tailscale serve --bg --https=9443 http://127.0.0.1:9099
```

The daemon probes the serve config at boot and prints `https://` URLs when the
proxy exists, falling back to plain http URLs when it doesn't. Direct
plain-http access on 9099 keeps working either way.

**Gate hardening that makes this safe:** the serve proxy delivers requests
from loopback, which would open the loopback-only registry API to every
tailnet member. The daemon therefore treats any loopback request carrying
proxy-injected headers (`Tailscale-User-Login`, `X-Forwarded-For`) as
non-local — the same pattern the dashboard uses for its cloudflared tunnel.
A genuinely local caller that spoofs those headers only locks itself out.

## Install (new machine)

```
cp repo/systemd/opendia-rooms.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opendia-rooms
tailscale serve --bg --https=9443 http://127.0.0.1:9099   # HTTPS (optional)
```

## Deliberately not included (build on it later)

TTL/reaper, public (non-tailnet) exposure, TLS, per-room auth, upload
scanning, quotas beyond the size cap.
