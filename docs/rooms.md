# Rooms — standing file exchange over the tailnet

One long-lived daemon on one fixed port. A **room** is a directory exposed at
an unguessable subpath: the page lists the directory's files for download and
(unless the room is read-only) accepts uploads into it. Rooms replace the
ad-hoc `python3 -m http.server` pattern, which had no registry (the same
directory ended up served on three ports at once), no upload direction, and a
habit of binding `0.0.0.0`.

## Usage

```
od-room open <dir> [--read-only] [--name NAME]   # → http://<host>:9099/r/<id>/
od-room list
od-room close <id|all>       # 'all' lists what it would close and confirms
```

`open` on a directory that already has a room returns the existing URL —
one directory, one room, always. URLs use the machine's MagicDNS FQDN
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
- Image rows carry a server-generated thumbnail (needs Pillow; degrades to
  plain rows without it). Thumbs are built once per content identity
  (path+mtime+size), cached under `~/OpenDia/.rooms-thumbs/`, pruned after
  30 days at daemon boot, and served with a day of client caching — a 2 MB
  photo costs ~1 KB per listing. Clicking a thumbnail opens an in-page
  lightbox with a download button; the original is only fetched then.
- Uploads: multipart, 500 MB cap, spooled to disk (never held in RAM),
  filename sanitised to a basename, collisions renamed `file-2.ext` — an
  upload can never overwrite an existing file.
- Path traversal is rejected at three layers (URL shape, dotfile check,
  resolved-path prefix check).
- The daemon refuses to open rooms on obviously sensitive paths (`~` itself,
  `~/.ssh`, `~/.claude`, `~/.config`, `~/.aws`, `~/.gnupg`, `~/OpenDia` root)
  or any directory containing a `.env` file. This is a mistake-catcher, not a
  security boundary — the tailnet is trusted.

## Install (new machine)

```
cp repo/systemd/opendia-rooms.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opendia-rooms
```

## Deliberately not included (build on it later)

TTL/reaper, public (non-tailnet) exposure, TLS, per-room auth, upload
scanning, quotas beyond the size cap.
