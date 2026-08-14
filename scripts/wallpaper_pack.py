#!/usr/bin/env python3
"""Turn raw photos into the dashboard's bundled wallpaper pack.

    python3 wallpaper_pack.py [--inbox DIR] [--dry-run]

Reads every image in the inbox (default ~/OpenDia/rooms/wallpaper-drop),
and for each one:

  * decodes and re-encodes the pixels — which drops EVERY metadata block.
    This is the whole reason this script exists: the repo is public and
    phone photos carry EXIF GPS coordinates of wherever they were taken.
    Copying files into the repo by hand is exactly the mistake this
    prevents. Re-encoding from pixels cannot leak what it never reads.
  * honours EXIF orientation first (transpose), so the pixels are upright
    before the metadata is discarded with the rest.
  * downscales to a 2560px long edge — the client paints with
    background-size: cover and its own storage ladder tops out at 2560,
    so shipping more would be bytes for nothing.
  * writes progressive JPEG q82 into dashboard/client/public/wallpapers/
    as wp-NN.jpg (order = inbox filename sort; names carry no trace of
    the original filename, which can itself leak places and dates).

Then rewrites wallpapers/manifest.json — the file the palette fetches:

    { "wallpapers": [ { "file": "wp-01.jpg", "label": "Wallpaper 1" } ] }

Labels default to "Wallpaper N"; edit the manifest by hand afterwards to
name them ("Ridge Sunrise") — re-runs preserve an existing label when the
file's content hash is unchanged.

Idempotent: same inbox in, same pack out. Verifies after writing that no
output file contains an EXIF/GPS block and refuses to leave one in place.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageOps

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "dashboard" / "client" / "public" / "wallpapers"
MANIFEST = OUT_DIR / "manifest.json"
DEFAULT_INBOX = Path.home() / "OpenDia" / "rooms" / "wallpaper-drop"

LONG_EDGE = 2560
QUALITY = 82
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"}


def load_manifest():
    try:
        return json.loads(MANIFEST.read_text())
    except (OSError, ValueError):
        return {"wallpapers": []}


def content_hash(path):
    return hashlib.sha1(path.read_bytes()).hexdigest()[:12]


def process(src: Path, dest: Path, dry: bool) -> bool:
    try:
        img = Image.open(src)
        img.load()
    except Exception as e:
        print(f"  skip {src.name}: {e}")
        return False
    # Upright the pixels while orientation metadata still exists…
    img = ImageOps.exif_transpose(img)
    # …then rebuild from raw pixels only. No .info, no exif= kwarg: the new
    # image never sees the old metadata, so nothing can survive into it.
    img = img.convert("RGB")
    w, h = img.size
    scale = LONG_EDGE / max(w, h)
    if scale < 1:
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    if not dry:
        img.save(dest, "JPEG", quality=QUALITY, progressive=True, optimize=True)
    print(f"  {src.name} -> {dest.name}  {img.size[0]}x{img.size[1]}")
    return True


def verify_clean(path: Path):
    """Belt and braces: refuse to keep an output that still carries EXIF."""
    with Image.open(path) as img:
        if img.getexif():
            path.unlink()
            sys.exit(f"ABORT: {path.name} still carried EXIF after re-encode; removed it")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", type=Path, default=DEFAULT_INBOX)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    sources = sorted(
        p for p in args.inbox.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    ) if args.inbox.is_dir() else []
    if not sources:
        sys.exit(f"no images in {args.inbox}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    old_labels = {w.get("hash"): w.get("label") for w in load_manifest().get("wallpapers", [])}

    entries = []
    n = 0
    for src in sources:
        n += 1
        dest = OUT_DIR / f"wp-{n:02d}.jpg"
        if not process(src, dest, args.dry_run):
            n -= 1
            continue
        if not args.dry_run:
            verify_clean(dest)
            h = content_hash(dest)
            entries.append({
                "file": dest.name,
                "label": old_labels.get(h) or f"Wallpaper {n}",
                "hash": h,
            })

    if args.dry_run:
        print(f"(dry run) would write {n} wallpapers + manifest")
        return

    # Remove leftovers from a previously larger pack.
    for stale in OUT_DIR.glob("wp-*.jpg"):
        if stale.name not in {e["file"] for e in entries}:
            stale.unlink()
            print(f"  removed stale {stale.name}")

    MANIFEST.write_text(json.dumps({"wallpapers": entries}, indent=2) + "\n")
    total = sum((OUT_DIR / e["file"]).stat().st_size for e in entries)
    print(f"pack: {len(entries)} wallpapers, {total // 1024} KB total; manifest written")


if __name__ == "__main__":
    main()
