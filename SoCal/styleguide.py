#!/usr/bin/env python3
"""Research a client's website into a structured style guide.

    styleguide.py research --url https://example.com --out DIR \
                           [--sheet SID] [--write] [--force] [--no-model]

Leans hard into what the client already ships: rendered-page palette (same
ground-truth extraction as sampler.py), the fonts their CSS actually asks for,
their logo, and the imagery on their pages (examined by a model with vision,
not guessed from filenames). Output:

  styleguide.json   everything found, machine-readable
  specimen.png      one-page visual: swatches, type, logo, descriptors
  site-img-*.jpg    the imagery that was examined (kept for the audit trail)

--write fills the STYLE_KEYS on the client's Config tab, BLANK KEYS ONLY by
default: an operator's curation always beats research (--force to overwrite).
The model-written descriptor fields (image_style, imagery_notes, voice, motif)
are drafts for the operator to edit in the dashboard, not gospel.
"""
import argparse
import colorsys
import io
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from urllib.parse import unquote, urljoin

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sampler import (fetch, extract, page_counts, choose_palette,  # noqa: E402
                     upgrade_logo_url, image_counts, luminance, saturation)
from sheet import STYLE_KEYS  # noqa: E402

GENERIC_FONTS = {"serif", "sans-serif", "monospace", "cursive", "fantasy",
                 "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
                 "inherit", "initial", "unset", "arial", "helvetica",
                 "helvetica neue", "times new roman", "georgia", "verdana",
                 "tahoma", "segoe ui", "roboto", "-apple-system",
                 "blinkmacsystemfont", "var(--font-family)",
                 # icon/emoji faces that ride real font stacks
                 "apple color emoji", "segoe ui emoji", "segoe ui symbol",
                 "noto color emoji", "material icons", "material symbols outlined",
                 "font awesome 5 free", "font awesome 5 brands", "font awesome 6 free",
                 "font awesome 6 brands", "fontawesome", "dashicons", "eicons",
                 "slick", "genericons", "revicons"}


def hue(hexcolor):
    r, g, b = (int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return colorsys.rgb_to_hls(r, g, b)[0] * 360


# ---------------------------------------------------------------- css / fonts
def gather_css(soup, base):
    css = ""
    for link in soup.find_all("link", rel=lambda v: v and "stylesheet" in v)[:6]:
        href = link.get("href")
        if href:
            try:
                css += fetch(urljoin(base, href)) + "\n"
            except Exception:
                pass
    for style in soup.find_all("style"):
        css += style.get_text() + "\n"
    return css


def extract_fonts(soup, css_text):
    """(heading_font, body_font, all_candidates) from Google Fonts links,
    @font-face, and which selectors the CSS actually applies families to."""
    google = []
    for link in soup.find_all("link", href=True):
        href = link["href"]
        if "fonts.googleapis.com" in href and "family=" in href:
            for fam in re.findall(r"family=([^&\"']+)", href):
                for f in unquote(fam).split("|"):
                    name = f.split(":")[0].replace("+", " ").strip()
                    if name:
                        google.append(name)
    google = [g for g in google if g.lower() not in GENERIC_FONTS]
    facenames = [m.strip().strip("'\"") for m in
                 re.findall(r"@font-face\s*{[^}]*?font-family\s*:\s*([^;}]+)", css_text)]
    facenames = [f for f in facenames if f.lower() not in GENERIC_FONTS]

    heading, body = Counter(), Counter()
    for chunk in css_text.split("}"):
        sel, brace, props = chunk.rpartition("{")
        if not brace:
            continue
        m = re.search(r"font-family\s*:\s*([^;]+)", props)
        if not m:
            continue
        fams = [f.strip().strip("'\"") for f in m.group(1).split(",")]
        fam = next((f for f in fams if f and f.lower() not in GENERIC_FONTS
                    and not f.startswith("var(")), None)
        if not fam:
            continue
        s = sel.lower()
        if re.search(r"\bh[1-4]\b|heading|title|display|hero", s):
            heading[fam] += 1
        if re.search(r"\bbody\b|\bhtml\b|\bp\b|paragraph|:root|\*", s):
            body[fam] += 1

    candidates = list(dict.fromkeys(google + facenames + list(body) + list(heading)))
    body_font = (body.most_common(1)[0][0] if body
                 else (google[0] if google else (candidates[0] if candidates else "")))
    heading_font = (heading.most_common(1)[0][0] if heading
                    else (google[1] if len(google) > 1 else body_font))
    return heading_font, body_font, candidates


# ---------------------------------------------------------------- palette
def color_distinct(h, ref):
    """Far enough from ref in hue, or in lightness when hues collide."""
    dh = abs(hue(h) - hue(ref))
    dh = min(dh, 360 - dh)
    return dh > 35 or abs(luminance(h) - luminance(ref)) > .35


def secondary_candidates(page, header, logo_counts, primary):
    """Ranked second-brand-color candidates, all clearly distinct from the
    primary. Votes come from header + logo only: brand chrome lives there,
    while full-page pixels are dominated by photography (a hero photo once
    nominated a skin tone). A ranked list, not one pick: at Config-write time
    the operator's kept primary may differ from the extracted one, and the
    secondary must be distinct from the color that actually stands."""
    votes = Counter()
    for counter, weight in ((header, 3), (logo_counts, 4)):
        total = sum(counter.values()) or 1
        for h, n in counter.items():
            # photos fragment into many small buckets; brand chrome is a few
            # big ones — only colors holding real area may nominate themselves
            if n / total >= .08 and saturation(h) > .30 and .10 < luminance(h) < .85:
                votes[h] += weight * n / total
    return [h for h, _ in votes.most_common(12) if color_distinct(h, primary)]


def rasterize_svg(svg_bytes, chrome, tmpdir):
    """SVG logos are invisible to pixel counting (PIL can't open them), which
    once let a hero photo outvote the brand mark. Render via chrome instead."""
    svg = os.path.join(tmpdir, "logo.svg")
    with open(svg, "wb") as fh:
        fh.write(svg_bytes)
    page = os.path.join(tmpdir, "logo.html")
    with open(page, "w") as fh:
        fh.write('<body style="margin:0;background:#fff"><img src="logo.svg" style="width:760px">')
    shot = os.path.join(tmpdir, "logo-raster.png")
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--window-size=800,500", f"--screenshot={shot}", "file://" + page],
                   check=True, capture_output=True)
    with open(shot, "rb") as fh:
        return fh.read()


# ---------------------------------------------------------------- imagery
def collect_images(soup, base, outdir, limit=6):
    from PIL import Image
    urls = []
    og = soup.find("meta", property="og:image")
    if og and og.get("content"):
        urls.append(urljoin(base, og["content"]))
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or ""
        blob = " ".join([src, " ".join(img.get("class") or []),
                         img.get("alt") or ""]).lower()
        if not src or src.startswith("data:") or src.lower().endswith(".svg"):
            continue
        if any(t in blob for t in ("logo", "icon", "sprite", "avatar", "badge", "pixel")):
            continue
        urls.append(urljoin(base, src))
    saved = []
    for u in dict.fromkeys(urls):
        try:
            im = Image.open(io.BytesIO(fetch(u, binary=True)))
            if im.width < 300 or im.height < 180:
                continue
            im = im.convert("RGB")
            im.thumbnail((900, 900))
            p = os.path.join(outdir, f"site-img-{len(saved) + 1}.jpg")
            im.save(p, quality=88)
            saved.append(p)
            if len(saved) >= limit:
                break
        except Exception:
            continue
    return saved


# ---------------------------------------------------------------- model pass
SYNTH_PROMPT = """You are writing a client style guide for a managed social media service, from research on the client's own website. Local image files are listed below; you MUST open each one with your Read tool and look at it before answering. The first is a full-page screenshot of their site; the rest are imagery pulled from their pages.

CLIENT: {name} ({domain})
SITE TITLE: {title}
SITE DESCRIPTION: {desc}
EXTRACTED PALETTE (rendered pixels, ground truth): primary {primary}, secondary {secondary}, ink {ink}, background {bg}
EXTRACTED FONTS: heading "{heading_font}", body "{body_font}"

WEBSITE TEXT EXCERPTS:
{corpus}

IMAGE FILES TO EXAMINE:
{paths}

Return ONLY a JSON object, no markdown fences:
{{"imagery_notes": "2-4 sentences: the imagery the site ACTUALLY uses (photography vs illustration vs graphics, typical subjects, mood, lighting, color treatment)",
  "image_style": "3-5 sentences: a concrete directive for generating NEW social post graphics that would feel native to this brand; specific adjectives a text-to-image model can act on; never ask for rendered text or logos",
  "voice": "2-3 sentences on the brand's writing voice, drawn only from the site text",
  "motif": "recurring visual devices worth reusing on graphics (shapes, patterns, textures, framing), or an empty string if none stand out"}}
Rules: no em dashes anywhere; describe only what you can actually see or read; do not invent facts about the business."""


def parse_model_json(text):
    body = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    start, end = body.find("{"), body.rfind("}")
    blob = body[start:end + 1]
    try:
        return json.loads(blob, strict=False)
    except Exception:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", blob), strict=False)


def synthesize(brief, guide, image_paths):
    prompt = SYNTH_PROMPT.format(
        name=brief["name"], domain=brief["domain"], title=brief["title"],
        desc=brief["description"], primary=guide["brand_primary"],
        secondary=guide["brand_secondary"] or "(none found)",
        ink=guide["brand_ink"], bg=guide["brand_bg"],
        heading_font=guide["heading_font"] or "unknown",
        body_font=guide["body_font"] or "unknown",
        corpus="\n".join("- " + c for c in brief["corpus"][:25]),
        paths="\n".join(image_paths))
    out = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=600)
    return parse_model_json(out.stdout)


# ---------------------------------------------------------------- specimen
SPECIMEN_HTML = """<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family={gf_heading}&family={gf_body}&display=swap" rel="stylesheet">
<style>
body {{ margin:0; width:1080px; font-family:"{body_font}",Arial,sans-serif; color:#1d1d1d; background:#fff; }}
.wrap {{ padding:56px 64px; }}
h1 {{ font-family:"{heading_font}",Arial,sans-serif; font-size:44px; margin:0 0 6px; }}
.sub {{ color:#666; font-size:20px; margin-bottom:36px; }}
.swatches {{ display:flex; gap:18px; margin-bottom:40px; }}
.sw {{ width:150px; }}
.sw .chip {{ height:96px; border-radius:10px; border:1px solid #ddd; }}
.sw .lab {{ font-size:16px; margin-top:8px; color:#444; }} .sw .hex {{ font-size:15px; color:#888; }}
.type {{ margin-bottom:36px; }}
.type .h {{ font-family:"{heading_font}",Arial,sans-serif; font-size:40px; font-weight:800; }}
.type .b {{ font-size:21px; margin-top:8px; line-height:1.5; }}
.type .name {{ font-size:15px; color:#888; margin-top:4px; }}
.logo {{ margin-bottom:36px; }} .logo img {{ max-height:110px; max-width:480px; }}
.block {{ margin-bottom:26px; }} .block .k {{ font-size:15px; letter-spacing:2px; color:#999; text-transform:uppercase; }}
.block .v {{ font-size:19px; line-height:1.55; margin-top:6px; white-space:pre-wrap; }}
</style><div class="wrap">
<h1>{name} style guide</h1><div class="sub">{domain} · researched {date}</div>
<div class="swatches">{swatches}</div>
<div class="type"><div class="h">Heading typeface</div><div class="name">{heading_font}</div>
<div class="b">Body copy sits in this face. The quick brown fox jumps over the lazy dog, 0123456789.</div><div class="name">{body_font}</div></div>
{logo_block}
{desc_blocks}
</div>"""


def specimen(guide, brief, out_png, chrome):
    sw = ""
    for lab, key in (("Primary", "brand_primary"), ("Secondary", "brand_secondary"),
                     ("Ink", "brand_ink"), ("Background", "brand_bg")):
        hx = guide.get(key) or ""
        if hx:
            sw += (f'<div class="sw"><div class="chip" style="background:{hx}"></div>'
                   f'<div class="lab">{lab}</div><div class="hex">{hx}</div></div>')
    logo_block = (f'<div class="logo"><img src="{guide["logo_url"]}"></div>'
                  if guide.get("logo_url") else "")
    desc = ""
    for k in ("image_style", "imagery_notes", "voice", "motif"):
        if guide.get(k):
            desc += (f'<div class="block"><div class="k">{k.replace("_", " ")}</div>'
                     f'<div class="v">{guide[k]}</div></div>')
    import datetime as dt
    html = SPECIMEN_HTML.format(
        name=brief["name"], domain=brief["domain"], date=dt.date.today().isoformat(),
        heading_font=guide.get("heading_font") or "Arial",
        body_font=guide.get("body_font") or "Arial",
        gf_heading=(guide.get("heading_font") or "").replace(" ", "+"),
        gf_body=(guide.get("body_font") or "").replace(" ", "+"),
        swatches=sw, logo_block=logo_block, desc_blocks=desc)
    tmp = out_png + ".html"
    with open(tmp, "w") as fh:
        fh.write(html)
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--hide-scrollbars", "--window-size=1080,1500",
                    "--virtual-time-budget=8000", f"--screenshot={out_png}",
                    "file://" + tmp], check=True, capture_output=True)
    os.remove(tmp)


# ---------------------------------------------------------------- research
def research(a):
    from bs4 import BeautifulSoup
    chrome = next((shutil.which(e) for e in ("chromium", "chromium-browser", "google-chrome")
                   if shutil.which(e)), None)
    if not chrome:
        sys.exit("no chromium on PATH")
    os.makedirs(a.out, exist_ok=True)

    print(f"extracting {a.url} ...")
    brief = extract(a.url)
    brief["name"] = a.name or (brief["title"].split("|")[0].split("-")[0].strip()
                               or brief["domain"])
    soup = BeautifulSoup(fetch(a.url), "html.parser")
    css_text = gather_css(soup, a.url)

    print("rendering page for palette ...")
    try:
        full, header = page_counts(chrome, a.url, a.out)
    except Exception as e:
        print(f"  (screenshot failed: {e}; CSS fallback)")
        full, header = Counter(), Counter()

    logo_counts = Counter()
    logo_url = ""
    if brief["logo"]:
        logo_url = upgrade_logo_url(brief["logo"])
        try:
            raw = fetch(logo_url, binary=True)
            if logo_url.split("?")[0].lower().endswith(".svg") or raw.lstrip()[:5] in (b"<svg ", b"<?xml"):
                raw = rasterize_svg(raw, chrome, a.out)
            from PIL import Image
            logo_counts = image_counts(Image.open(io.BytesIO(raw)))
            # whitespace and near-black text aren't brand signal; keep only the
            # colored pixels so the mark's color carries its full weight
            logo_counts = Counter({h: n for h, n in logo_counts.items()
                                   if saturation(h) > .25 and .10 < luminance(h) < .85}) or logo_counts
        except Exception as e:
            print(f"  (logo pixel read failed: {e})")

    palette = choose_palette(full, header, logo_counts, brief["css_hexes"])
    heading_font, body_font, font_candidates = extract_fonts(soup, css_text)

    sec_cands = secondary_candidates(full, header, logo_counts, palette["accent"])
    guide = {
        "brand_primary": palette["accent"],
        "brand_secondary": sec_cands[0] if sec_cands else "",
        "brand_ink": palette["ink"],
        "brand_bg": palette["bg"],
        "heading_font": heading_font,
        "body_font": body_font,
        "logo_url": logo_url,
        "motif": "", "image_style": "", "imagery_notes": "", "voice": "",
    }
    print("palette:", {k: guide[k] for k in ("brand_primary", "brand_secondary",
                                             "brand_ink", "brand_bg")})
    print("fonts:", heading_font or "?", "/", body_font or "?",
          f"(candidates: {', '.join(font_candidates) or 'none'})")

    print("collecting site imagery ...")
    shots = [os.path.join(a.out, "page.png")] if os.path.exists(os.path.join(a.out, "page.png")) else []
    images = collect_images(soup, a.url, a.out)
    print(f"  {len(images)} usable images")

    if not a.no_model:
        print("model pass over imagery + copy ...")
        try:
            synth = synthesize(brief, guide, shots + images)
            for k in ("imagery_notes", "image_style", "voice", "motif"):
                guide[k] = (synth.get(k) or "").replace("—", ",").strip()
        except Exception as e:
            print(f"  (model pass failed: {e}; descriptor fields left blank)")

    out_json = os.path.join(a.out, "styleguide.json")
    with open(out_json, "w") as fh:
        json.dump({"brief": {k: brief[k] for k in ("url", "domain", "name", "title",
                                                   "description", "phone", "socials")},
                   "guide": guide, "font_candidates": font_candidates}, fh, indent=2)
    print("wrote", out_json)

    try:
        specimen(guide, brief, os.path.join(a.out, "specimen.png"), chrome)
        print("wrote", os.path.join(a.out, "specimen.png"))
    except Exception as e:
        print(f"  (specimen render failed: {e})")

    if a.write:
        if not a.sheet:
            sys.exit("--write needs --sheet")
        from sheet import get_sheets_service, read_config, write_config
        svc = get_sheets_service()
        cfg = read_config(svc, a.sheet)
        written, kept = [], []
        for k in STYLE_KEYS:
            v = guide.get(k, "")
            if k == "brand_secondary":
                # distinct from the primary that actually stands (the operator
                # may have kept a curated primary the extraction didn't pick)
                eff = cfg.get("brand_primary") or guide["brand_primary"]
                v = next((c for c in sec_cands if color_distinct(c, eff)), "")
            if not v:
                continue
            if cfg.get(k) and not a.force:
                kept.append(k)
                continue
            write_config(svc, a.sheet, k, v)
            written.append(k)
        print("config written:", ", ".join(written) or "nothing")
        if kept:
            print("kept operator values (use --force to overwrite):", ", ".join(kept))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("research", help="website -> style guide")
    r.add_argument("--url", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--name", help="client display name (default: from site title)")
    r.add_argument("--sheet", default="", help="client sheet id (for --write)")
    r.add_argument("--write", action="store_true", help="fill blank Config style keys")
    r.add_argument("--force", action="store_true", help="overwrite non-blank keys too")
    r.add_argument("--no-model", action="store_true", help="skip the model descriptor pass")
    a = ap.parse_args()
    research(a)


if __name__ == "__main__":
    main()
