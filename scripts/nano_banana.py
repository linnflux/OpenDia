#!/usr/bin/env python3
"""
nano_banana.py — Generate images with Google's Gemini 2.5 Flash Image model
(marketing name: "Nano Banana") via the Gemini API.

Usage:
    nano_banana.py "prompt text"
    nano_banana.py "prompt text" --out ~/OpenDia/Debug/custom.png
    nano_banana.py "make the sky purple" --reference ~/OpenDia/Debug/source.png
    nano_banana.py "a logo" --model gemini-2.5-flash-image

The API key is read from ~/.claude/mcp-credentials/gemini/api_key (0600).

Output: writes a PNG to ~/OpenDia/Debug/nano-banana-YYYYMMDD-HHMMSS.png
by default and prints the absolute path on stdout. Any text the model
returns alongside the image is printed to stderr.
"""

import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

API_KEY_PATH = Path.home() / ".claude" / "mcp-credentials" / "gemini" / "api_key"
DEFAULT_MODEL = "gemini-2.5-flash-image"
DEFAULT_OUT_DIR = Path.home() / "OpenDia" / "Debug"
API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def load_api_key():
    if not API_KEY_PATH.exists():
        die(f"API key not found at {API_KEY_PATH}. See reference_gemini.md.")
    key = API_KEY_PATH.read_text().strip()
    if not key:
        die(f"API key file is empty: {API_KEY_PATH}")
    return key


def load_reference_part(path):
    """Read a local image and return a Gemini inlineData part."""
    p = Path(path).expanduser()
    if not p.exists():
        die(f"reference image not found: {p}")
    mime, _ = mimetypes.guess_type(str(p))
    if not mime or not mime.startswith("image/"):
        die(f"reference is not a recognized image type: {p}")
    data = base64.b64encode(p.read_bytes()).decode("ascii")
    return {"inlineData": {"mimeType": mime, "data": data}}


def build_payload(prompt, reference_paths):
    parts = [{"text": prompt}]
    for ref in reference_paths:
        parts.append(load_reference_part(ref))
    return {"contents": [{"parts": parts}]}


def call_api(model, api_key, payload):
    url = f"{API_BASE}/{model}:generateContent"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-goog-api-key": api_key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        die(f"API error {e.code}: {detail}")
    except urllib.error.URLError as e:
        die(f"network error: {e.reason}")


def parse_response(resp):
    """Walk the Gemini response and pull out image bytes + any text."""
    candidates = resp.get("candidates") or []
    if not candidates:
        die(f"no candidates in response: {json.dumps(resp)[:500]}")
    parts = candidates[0].get("content", {}).get("parts", []) or []
    image_bytes = None
    image_mime = None
    text_chunks = []
    for part in parts:
        if "inlineData" in part:
            inline = part["inlineData"]
            image_bytes = base64.b64decode(inline["data"])
            image_mime = inline.get("mimeType", "image/png")
        elif "text" in part:
            text_chunks.append(part["text"])
    if image_bytes is None:
        die(f"no image in response. text: {' '.join(text_chunks) or '(none)'}")
    return image_bytes, image_mime, "\n".join(text_chunks)


def default_out_path(mime):
    ext = mimetypes.guess_extension(mime) or ".png"
    if ext == ".jpe":
        ext = ".jpg"
    DEFAULT_OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return DEFAULT_OUT_DIR / f"nano-banana-{stamp}{ext}"


def main():
    parser = argparse.ArgumentParser(
        description="Generate images with Gemini 2.5 Flash Image (Nano Banana).",
    )
    parser.add_argument("prompt", help="text prompt")
    parser.add_argument(
        "--out",
        type=Path,
        help="output file path (default: ~/OpenDia/Debug/nano-banana-TIMESTAMP.png)",
    )
    parser.add_argument(
        "--reference",
        action="append",
        default=[],
        metavar="PATH",
        help="reference image for edit-style generation (repeatable)",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"model id (default: {DEFAULT_MODEL})",
    )
    args = parser.parse_args()

    api_key = load_api_key()
    payload = build_payload(args.prompt, args.reference)
    resp = call_api(args.model, api_key, payload)
    image_bytes, mime, text = parse_response(resp)

    out_path = args.out.expanduser() if args.out else default_out_path(mime)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(image_bytes)

    if text.strip():
        print(text.strip(), file=sys.stderr)
    print(str(out_path))


if __name__ == "__main__":
    main()
