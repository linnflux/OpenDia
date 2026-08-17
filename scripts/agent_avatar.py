#!/usr/bin/env python3
"""
agent_avatar.py — Stylize an ODA agent's avatar from a base image.

One fixed house prompt, so every agent gets the identical treatment and the
roster reads as one set. The OpenDia-blue ring is drawn by the dashboard's
CSS, never baked into the image — the frame stays theme-consistent and
regenerating the art never changes it.

Usage:
    agent_avatar.py <slug> <base-image>
    agent_avatar.py carlos-f ~/OpenDia/agents/avatars-inbox/carlos.png

Output: ~/OpenDia/agents/<slug>/avatar.png (the dashboard serves it via
/api/file and falls back to a monogram when absent). The base image is
copied alongside as base.<ext> so the avatar can be regenerated later.
"""

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

NANO_BANANA = Path(__file__).resolve().parent / "nano_banana.py"
AGENTS_ROOT = Path.home() / "OpenDia" / "agents"

HOUSE_PROMPT = (
    "Restyle this portrait as a team avatar. Isolate the subject and remove "
    "the background completely, replacing it with a soft neutral dark-slate "
    "radial gradient. Apply a subtle unified illustration style: clean edges, "
    "gentle color grading, slightly warm key light. Center the subject and "
    "frame the composition for a circular crop with comfortable headroom — "
    "nothing important within 10% of the edges. Square 1:1 output. Do not add "
    "any text, border, ring, logo, or watermark."
)


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def normalize_square(path, size=512):
    """Pad to square with the image's own corner color, then resize.

    The model is asked for 1:1 but does not reliably deliver it, and a
    non-square image center-cropped into the dashboard's circular frame
    loses whatever sticks out (an antenna, a shoulder). Padding with the
    sampled corner color extends the portrait's own backdrop, so the circle
    always shows the whole subject on a seamless ground.
    """
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    if w != h:
        side = max(w, h)
        corners = [img.getpixel(p) for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]]
        fill = tuple(sum(c[i] for c in corners) // 4 for i in range(4))
        canvas = Image.new("RGBA", (side, side), fill)
        canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
        img = canvas
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)


def main():
    if len(sys.argv) != 3:
        die(f"usage: {Path(sys.argv[0]).name} <slug> <base-image>")
    slug, base = sys.argv[1], Path(sys.argv[2]).expanduser()

    agent_dir = AGENTS_ROOT / slug
    if not agent_dir.is_dir():
        die(f"no agent directory at {agent_dir} — check the slug")
    if not base.is_file():
        die(f"base image not found: {base}")

    out = agent_dir / "avatar.png"
    kept_base = agent_dir / f"base{base.suffix.lower()}"

    result = subprocess.run(
        [sys.executable, str(NANO_BANANA), HOUSE_PROMPT,
         "--reference", str(base), "--out", str(out)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        die(f"nano_banana failed:\n{result.stderr.strip()}")

    normalize_square(out)

    if base.resolve() != kept_base.resolve():
        shutil.copy2(base, kept_base)

    print(out)


if __name__ == "__main__":
    main()
