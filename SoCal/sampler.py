#!/usr/bin/env python3
"""Generate SoCal sample posts for a prospect from nothing but their website.

    sampler.py --url https://example.com --out DIR [--name "Company"] [--posts 3]

The sales wedge: fetch the prospect's site, extract their brand (palette, logo,
phone, socials, what they actually do), have a model draft 2-3 posts in a
plainspoken voice, and render each as a finished 1080x1080 card in THEIR brand
colors with THEIR logo. Output: brief.json + one PNG per post, ready to audit
and drop into a pitch.

Every render must be human-audited before a prospect sees it. Captions are
draft copy, not gospel: the operator edits before anything ships.
"""
import argparse
import base64
import colorsys
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) SoCal-sampler/1.0"}
HEX = re.compile(r"#[0-9a-fA-F]{6}\b")
PHONE = re.compile(r"(?:tel:\+?1?)?(\d{3})[.\-\s)]{0,2}(\d{3})[.\-\s]?(\d{4})")


# ---------------------------------------------------------------- fetch/parse
def fetch(url, timeout=20, binary=False):
    r = requests.get(url, headers=UA, timeout=timeout, allow_redirects=True)
    r.raise_for_status()
    return r.content if binary else r.text


def luminance(hexcolor):
    r, g, b = (int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def saturation(hexcolor):
    r, g, b = (int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return colorsys.rgb_to_hls(r, g, b)[2]


# CSS-only colors that are usually a framework's, not the brand's
FRAMEWORK_DEFAULTS = {"#007bff", "#0d6efd", "#0056b3", "#2ea3f2", "#17a2b8",
                      "#28a745", "#dc3545", "#ffc107", "#6c757d", "#f8f9fa", "#212529"}


def _bucket(r, g, b):
    """merge antialiased near-duplicates: quantize channels to 16 levels"""
    q = lambda v: min(240, (v // 16) * 16 + 8)
    return f"#{q(r):02x}{q(g):02x}{q(b):02x}"


def image_counts(img):
    """Counter of quantized hex -> pixels, transparency composited on white."""
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        from PIL import Image as _I
        base = _I.new("RGBA", img.size, (255, 255, 255, 255))
        base.paste(img, mask=img.split()[-1])
        img = base
    img = img.convert("RGB")
    img.thumbnail((160, 160))
    return Counter(_bucket(*px) for px in img.getdata())


def page_counts(chrome, url, tmpdir):
    """(full page, header region) color Counters from a rendered screenshot."""
    from PIL import Image
    shot = os.path.join(tmpdir, "page.png")
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--hide-scrollbars", "--window-size=1280,2200",
                    "--virtual-time-budget=8000", f"--screenshot={shot}", url],
                   check=True, capture_output=True)
    im = Image.open(shot).convert("RGB")
    return image_counts(im), image_counts(im.crop((0, 0, im.width, 300)))


def choose_palette(page, header, logo, css_hexes):
    """Rendered pixels are ground truth; the logo is the strongest brand signal;
    CSS text is a last-resort fallback (framework defaults excluded)."""
    votes = Counter()
    for counter, weight in ((page, 1), (header, 3), (logo, 4)):
        total = sum(counter.values()) or 1
        for h, n in counter.items():
            if saturation(h) > .25 and .10 < luminance(h) < .80:
                votes[h] += weight * n / total
    accent = votes.most_common(1)[0][0] if votes else None
    if not accent:
        css = [h.lower() for h in css_hexes
               if h.lower() not in FRAMEWORK_DEFAULTS
               and saturation(h) > .35 and .15 < luminance(h) < .75]
        accent = Counter(css).most_common(1)[0][0] if css else "#2e7d32"
    darks = [(n, h) for h, n in page.items() if luminance(h) < .22]
    lights = [(n, h) for h, n in page.items() if luminance(h) > .85]
    ink = max(darks)[1] if darks else "#1d1d1d"
    bg = max(lights)[1] if lights else "#ffffff"
    return {"accent": accent, "ink": ink, "bg": bg}


def upgrade_logo_url(url):
    """Ask common image CDNs for a bigger rendition (GoDaddy W+M's wsimg
    serves whatever height you request in the transform segment)."""
    if "wsimg.com" in url:
        return re.sub(r"rs=h:\d+", "rs=h:600", url)
    return url


def logo_blob_shape(logo_bytes, accent):
    """Extract the accent-colored shape from the logo as a transparent PNG
    (silhouette smoothed, recolored in the accent). Returns a data URI, or
    None when the logo has no meaningful region near the accent color."""
    import io
    from PIL import Image, ImageFilter
    ar, ag, ab = (int(accent[i:i + 2], 16) for i in (1, 3, 5))
    im = Image.open(io.BytesIO(logo_bytes))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        base = Image.new("RGBA", im.size, (255, 255, 255, 255))
        base.paste(im, mask=im.split()[-1])
        im = base
    im = im.convert("RGB")
    px = im.load()
    mask = Image.new("L", im.size, 0)
    dark = Image.new("L", im.size, 0)
    mp, dp = mask.load(), dark.load()
    hits = 0
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = px[x, y]
            if r + g + b < 260:
                dp[x, y] = 255
            elif abs(r - ar) + abs(g - ag) + abs(b - ab) < 110:
                mp[x, y] = 255
                hits += 1
    if hits < im.width * im.height * 0.02:
        return None
    # anti-aliased halos around dark lettering read as near-accent: remove
    # everything within a few px of a dark pixel before reconstructing
    halo = dark.filter(ImageFilter.MaxFilter(7))
    mask = Image.composite(Image.new("L", im.size, 0), mask, halo)
    # close the gaps where logo lettering crosses the shape (dilate then erode)
    k = max(9, (min(im.size) // 12) | 1)
    mask = mask.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.MinFilter(k))
    # keep only the largest connected region and fill its internal holes,
    # working at a small resolution where BFS is cheap
    w = 150
    small = mask.resize((w, max(1, int(w * mask.height / mask.width))))
    grid = [[1 if small.getpixel((x, y)) > 127 else 0 for x in range(small.width)]
            for y in range(small.height)]
    H, W = len(grid), len(grid[0])

    def flood(sy, sx, match, label, labels):
        stack = [(sy, sx)]
        cells = []
        while stack:
            y, x = stack.pop()
            if 0 <= y < H and 0 <= x < W and labels[y][x] == 0 and grid[y][x] == match:
                labels[y][x] = label
                cells.append((y, x))
                stack += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]
        return cells

    labels = [[0] * W for _ in range(H)]
    best = []
    lab = 0
    for y in range(H):
        for x in range(W):
            if grid[y][x] and not labels[y][x]:
                lab += 1
                cells = flood(y, x, 1, lab, labels)
                if len(cells) > len(best):
                    best = cells
    keep = {(y, x) for y, x in best}
    # outside = empty cells reachable from the border; unreachable empties are holes
    outside = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in (0, W - 1):
            if not grid[y][x] and not outside[y][x]:
                flood(y, x, 0, 1, outside)
    for x in range(W):
        for y in (0, H - 1):
            if not grid[y][x] and not outside[y][x]:
                flood(y, x, 0, 1, outside)
    from PIL import Image as _I
    comp = _I.new("L", (W, H), 0)
    for y in range(H):
        for x in range(W):
            if (y, x) in keep or (not grid[y][x] and not outside[y][x]):
                comp.putpixel((x, y), 255)
    bbox = comp.getbbox()
    if not bbox:
        return None
    comp = comp.crop(bbox)
    # smooth hard: letter-scale detail dies, the organic outline survives
    comp = comp.resize((900, max(1, int(900 * comp.height / comp.width))), Image.LANCZOS)
    comp = comp.filter(ImageFilter.GaussianBlur(22)).point(lambda v: 255 if v > 105 else 0)
    comp = comp.filter(ImageFilter.GaussianBlur(3))
    out = Image.new("RGBA", comp.size, (ar, ag, ab, 0))
    solid = Image.new("RGBA", comp.size, (ar, ag, ab, 255))
    out.paste(solid, mask=comp)
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def find_logo(soup, base):
    cands = []
    for img in soup.find_all("img"):
        blob = " ".join([img.get("src") or "", img.get("alt") or "",
                         " ".join(img.get("class") or [])]).lower()
        if "logo" in blob:
            cands.append(img.get("src"))
    if not cands:
        og = soup.find("meta", property="og:image")
        if og and og.get("content"):
            cands.append(og["content"])
    return urljoin(base, cands[0]) if cands and cands[0] else None


def extract(url):
    html = fetch(url)
    soup = BeautifulSoup(html, "html.parser")
    base = url

    title = (soup.title.string or "").strip() if soup.title else ""
    desc = ""
    md = soup.find("meta", attrs={"name": "description"})
    if md and md.get("content"):
        desc = md["content"].strip()

    css_text = ""
    for link in soup.find_all("link", rel=lambda v: v and "stylesheet" in v)[:4]:
        href = link.get("href")
        if href:
            try:
                css_text += fetch(urljoin(base, href))
            except Exception:
                pass
    for style in soup.find_all("style"):
        css_text += style.get_text()

    hexes = HEX.findall(css_text) + HEX.findall(html)

    phone = ""
    for a in soup.find_all("a", href=re.compile(r"^tel:")):
        m = PHONE.search(a["href"])
        if m:
            phone = "({}) {}-{}".format(*m.groups())
            break
    if not phone:
        m = PHONE.search(soup.get_text(" "))
        if m:
            phone = "({}) {}-{}".format(*m.groups())

    socials = sorted({a["href"] for a in soup.find_all("a", href=True)
                      if re.search(r"(facebook|instagram|linkedin)\.com/", a["href"])})

    corpus = []
    for tag in soup.find_all(["h1", "h2", "h3", "p", "li"]):
        t = tag.get_text(" ", strip=True)
        if 15 < len(t) < 300:
            corpus.append(t)
    corpus = list(dict.fromkeys(corpus))[:40]

    return {"url": url, "domain": urlparse(url).netloc.replace("www.", ""),
            "title": title, "description": desc, "css_hexes": hexes,
            "phone": phone, "socials": socials,
            "logo": find_logo(soup, base), "corpus": corpus}


# ---------------------------------------------------------------- captions
PROMPT = """You are drafting {n} sample social media posts (Facebook/Instagram) for the company below, based only on what their website says. These are SALES SAMPLES to show the company what professionally managed posts would look like for them, so they must feel specific to this business, not generic.

COMPANY: {name} ({domain})
WEBSITE SAYS:
{corpus}

Rules:
- Plainspoken and warm, 2-4 short sentences per caption. Concrete over hype.
- NO em dashes anywhere. No hashtag spam (2 tasteful hashtags max, or none).
- No relative-time phrases ("this week", "tomorrow").
- Do not invent facts, prices, or offers not implied by the website text.
- Each post a different angle: e.g. what-we-do intro, a specific service/benefit, trust/community/people.
- End each caption with the domain on its own line: {domain}

Return ONLY a JSON array, no markdown fences, with {n} objects:
{{"slug": "kebab-name", "eyebrow": "SHORT LABEL / CATEGORY", "headline_lines": ["2-4 words", "per line", "(2-3 lines)"], "note_lines": ["one or two short lines", "expanding the headline"], "chip": "{domain}", "caption": "the full post text"}}
Make exactly one headline line the emphasis line by prefixing it with * (rendered in the brand accent color)."""


def draft_posts(brief, name, n):
    prompt = PROMPT.format(n=n, name=name, domain=brief["domain"],
                           corpus="\n".join("- " + c for c in brief["corpus"]))
    out = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=600)
    text = out.stdout.strip()
    text = re.sub(r"^```(json)?|```$", "", text, flags=re.M).strip()
    start, end = text.find("["), text.rfind("]")
    posts = json.loads(text[start:end + 1])
    for p in posts:
        p["caption"] = p["caption"].replace("—", ",")  # lint: no em dashes
    return posts[:n]


# ---------------------------------------------------------------- render
CARD_CSS = """
* {{ margin:0; padding:0; box-sizing:border-box; }}
html,body {{ width:1080px; height:1080px; }}
body {{ font-family:"Source Sans 3",Arial,sans-serif; -webkit-font-smoothing:antialiased; }}
.card {{ position:relative; width:1080px; height:1080px; overflow:hidden;
  background:{bg}; border-top:12px solid {accent}; }}
.stack {{ position:absolute; left:80px; right:80px; top:140px; color:{ink}; }}
.eyebrow {{ font-size:30px; font-weight:700; letter-spacing:4px; color:{accent};
  text-transform:uppercase; margin-bottom:34px; }}
h1 {{ font-weight:900; font-size:{h1}px; line-height:1.02; letter-spacing:-1.5px; }}
h1 span {{ display:block; }}
h1 .g {{ color:{accent}; }}
.rule {{ height:7px; width:170px; background:{accent}; border-radius:4px; margin:42px 0 36px; }}
.note {{ font-size:38px; font-weight:500; color:{ink}; opacity:.82; line-height:1.5; }}
.chip {{ display:inline-block; margin-top:48px; background:{accent}; color:{chipink};
  font-size:34px; font-weight:800; padding:20px 38px; border-radius:10px; letter-spacing:.5px; }}
.logo {{ position:absolute; right:72px; bottom:64px; max-width:300px; max-height:110px; display:block; }}
.wordmark {{ position:absolute; right:80px; bottom:70px; font-size:40px; font-weight:900;
  color:{ink}; letter-spacing:-.5px; }}
.url {{ position:absolute; left:80px; bottom:76px; font-size:27px; font-weight:600;
  color:{ink}; opacity:.55; letter-spacing:1px; }}
"""


def card_html(post, brief, name, logo_data_uri, emphasis="color", blob_uri=None):
    pal = brief["palette"]
    ink = pal["ink"] if luminance(pal["bg"]) > .5 else "#f7f8fa"
    chipink = "#ffffff" if luminance(pal["accent"]) < .6 else pal["ink"]
    blob_css = ""
    if emphasis == "blob":
        if blob_uri:
            # the client's OWN logo shape at its natural aspect, behind the whole
            # headline — the same composition their logo uses (text on the blob)
            blob_css = (" .hwrap { position:relative; }"
                        " .hwrap img.blobbg { position:absolute; height:118%;"
                        "   width:auto; left:-34px; top:50%;"
                        "   transform:translateY(-51%); z-index:0; }"
                        " .hwrap h1 { position:relative; z-index:1; }"
                        f" h1 .g {{ color:{ink}; }}")
        else:
            # no usable shape in the logo: generic organic blob fallback
            blob_css = (f"h1 .g {{ display:inline-block; color:{chipink}; background:{pal['accent']};"
                        " padding:2px 34px 10px 28px; margin:6px 0;"
                        " border-radius: 58% 42% 55% 45% / 55% 48% 60% 45%;"
                        " transform: rotate(-1.4deg); }")
    lines = []
    for ln in post["headline_lines"]:
        if ln.startswith("*"):
            lines.append(f'<span class="g">{ln[1:].strip()}</span>')
        else:
            lines.append(f"<span>{ln}</span>")
    h1 = 118 if sum(len(l) for l in post["headline_lines"]) < 34 else 96
    # avoid saying the domain twice: prefer the phone in the chip, else drop the url line
    chip = post["chip"]
    url_line = f'<div class="url">{brief["domain"]}</div>'
    if chip.strip().lower() == brief["domain"].lower():
        if brief.get("phone"):
            chip = brief["phone"]
        else:
            url_line = ""
    logo = (f'<img class="logo" src="{logo_data_uri}">' if logo_data_uri
            else f'<div class="wordmark">{name}</div>')
    css = CARD_CSS.format(bg=pal["bg"], accent=pal["accent"], ink=ink,
                          chipink=chipink, h1=h1) + blob_css
    h1_html = f'<h1>{"".join(lines)}</h1>'
    if emphasis == "blob" and blob_uri:
        h1_html = f'<div class="hwrap"><img class="blobbg" src="{blob_uri}">{h1_html}</div>'
    return (f"<!doctype html><html><head><meta charset=utf-8><style>{css}</style></head>"
            f'<body><div class="card"><div class="stack">'
            f'<div class="eyebrow">{post["eyebrow"]}</div>'
            f'{h1_html}<div class="rule"></div>'
            f'<div class="note">{"<br>".join(post["note_lines"])}</div>'
            f'<div class="chip">{chip}</div></div>'
            f'{logo}{url_line}</div></body></html>')


def render(name, html, out_png, chrome):
    tmp = out_png + ".html"
    with open(tmp, "w") as fh:
        fh.write(html)
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--hide-scrollbars", "--force-device-scale-factor=1",
                    "--virtual-time-budget=4000", "--window-size=1080,1240",
                    f"--screenshot={out_png}", "file://" + tmp],
                   check=True, capture_output=True)
    from PIL import Image
    Image.open(out_png).convert("RGB").crop((0, 0, 1080, 1080)).save(out_png)
    os.remove(tmp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", help="company display name (default: from site title)")
    ap.add_argument("--posts", type=int, default=3)
    ap.add_argument("--accent", help="override accent hex (operator knows best)")
    ap.add_argument("--ink", help="override ink hex")
    ap.add_argument("--bg", help="override background hex")
    ap.add_argument("--emphasis", choices=["color", "blob"], default="color",
                    help="emphasis line: accent-colored text, or a logo-style blob behind it")
    ap.add_argument("--reuse", action="store_true",
                    help="reuse brief.json + posts.json already in --out (style A/Bs on identical content)")
    a = ap.parse_args()

    chrome = next((shutil.which(e) for e in ("chromium", "chromium-browser", "google-chrome") if shutil.which(e)), None)
    if not chrome:
        sys.exit("no chromium on PATH")
    os.makedirs(a.out, exist_ok=True)

    reuse = a.reuse and os.path.exists(os.path.join(a.out, "brief.json"))
    if reuse:
        print("reusing brief.json from", a.out)
        brief = json.load(open(os.path.join(a.out, "brief.json")))
        name = a.name or brief.get("name") or brief["domain"]
        brief["name"] = name
    else:
        print(f"extracting brand from {a.url} ...")
        brief = extract(a.url)
        name = a.name or (brief["title"].split("|")[0].split("-")[0].strip() or brief["domain"])
        brief["name"] = name

    logo_uri, logo_counts, logo_bytes, logo_ext = None, Counter(), None, ""
    if brief["logo"]:
        try:
            logo_src = upgrade_logo_url(brief["logo"])
            logo_bytes = fetch(logo_src, binary=True)
            logo_ext = re.search(r"\.(png|jpe?g|svg|webp)", brief["logo"].lower())
            logo_ext = logo_ext.group(1) if logo_ext else "png"
            mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                    "svg": "image/svg+xml", "webp": "image/webp"}.get(logo_ext, "image/png")
            logo_uri = f"data:{mime};base64," + base64.b64encode(logo_bytes).decode()
            if logo_ext != "svg":
                import io
                from PIL import Image
                logo_counts = image_counts(Image.open(io.BytesIO(logo_bytes)))
        except Exception as e:
            print(f"  (logo fetch failed: {e}; using text wordmark)")

    if reuse:
        palette = brief["palette"]
    else:
        print("reading rendered page colors ...")
        try:
            full, header = page_counts(chrome, a.url, a.out)
        except Exception as e:
            print(f"  (screenshot failed: {e}; falling back to CSS colors)")
            full, header = Counter(), Counter()
        palette = choose_palette(full, header, logo_counts, brief["css_hexes"])
    for k in ("accent", "ink", "bg"):
        if getattr(a, k):
            palette[k] = getattr(a, k)
    brief["palette"] = palette

    with open(os.path.join(a.out, "brief.json"), "w") as fh:
        json.dump(brief, fh, indent=2)
    print(f"  palette {palette}  phone {brief['phone'] or '-'}  "
          f"logo {'yes' if logo_uri else 'wordmark'}  socials {len(brief['socials'])}")

    posts_path = os.path.join(a.out, "posts.json")
    if reuse and os.path.exists(posts_path):
        print("reusing posts.json")
        posts = json.load(open(posts_path))[:a.posts]
    else:
        print(f"drafting {a.posts} posts ...")
        posts = draft_posts(brief, name, a.posts)
        with open(posts_path, "w") as fh:
            json.dump(posts, fh, indent=2)

    blob_uri = None
    if a.emphasis == "blob" and logo_bytes and logo_ext != "svg":
        blob_uri = logo_blob_shape(logo_bytes, brief["palette"]["accent"])
        print("  logo blob shape:", "extracted from logo" if blob_uri else "not found; generic fallback")

    for i, p in enumerate(posts, 1):
        png = os.path.join(a.out, f"sample-{i}-{p['slug']}.png")
        render(name, card_html(p, brief, name, logo_uri, a.emphasis, blob_uri), png, chrome)
        print(f"  {os.path.basename(png)}")
    print(f"\n{len(posts)} samples in {a.out} — AUDIT EVERY CARD before a prospect sees it.")


if __name__ == "__main__":
    main()
