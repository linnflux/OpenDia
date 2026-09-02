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


def pick_palette(hexes):
    """accent / ink / bg from a frequency-weighted hex list."""
    uniq = Counter(h.lower() for h in hexes)
    if not uniq:
        return {"accent": "#2e7d32", "ink": "#1d1d1d", "bg": "#ffffff"}
    # accent: most frequent saturated mid-luminance color
    sat = [(h, n) for h, n in uniq.items() if saturation(h) > .35 and .15 < luminance(h) < .75]
    sat.sort(key=lambda x: (-x[1], -saturation(x[0])))
    accent = sat[0][0] if sat else max(uniq, key=uniq.get)
    darks = [h for h in uniq if luminance(h) < .2]
    lights = [h for h in uniq if luminance(h) > .9]
    ink = max(darks, key=lambda h: uniq[h]) if darks else "#1d1d1d"
    bg = max(lights, key=lambda h: uniq[h]) if lights else "#ffffff"
    return {"accent": accent, "ink": ink, "bg": bg}


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
    palette = pick_palette(hexes)

    phone = ""
    m = PHONE.search(html)
    if m:
        phone = "-".join(m.groups())

    socials = sorted({a["href"] for a in soup.find_all("a", href=True)
                      if re.search(r"(facebook|instagram|linkedin)\.com/", a["href"])})

    corpus = []
    for tag in soup.find_all(["h1", "h2", "h3", "p", "li"]):
        t = tag.get_text(" ", strip=True)
        if 15 < len(t) < 300:
            corpus.append(t)
    corpus = list(dict.fromkeys(corpus))[:40]

    return {"url": url, "domain": urlparse(url).netloc.replace("www.", ""),
            "title": title, "description": desc, "palette": palette,
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


def card_html(post, brief, name, logo_data_uri):
    pal = brief["palette"]
    ink = pal["ink"] if luminance(pal["bg"]) > .5 else "#f7f8fa"
    chipink = "#ffffff" if luminance(pal["accent"]) < .6 else pal["ink"]
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
                          chipink=chipink, h1=h1)
    return (f"<!doctype html><html><head><meta charset=utf-8><style>{css}</style></head>"
            f'<body><div class="card"><div class="stack">'
            f'<div class="eyebrow">{post["eyebrow"]}</div>'
            f'<h1>{"".join(lines)}</h1><div class="rule"></div>'
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
    a = ap.parse_args()

    chrome = next((shutil.which(e) for e in ("chromium", "chromium-browser", "google-chrome") if shutil.which(e)), None)
    if not chrome:
        sys.exit("no chromium on PATH")
    os.makedirs(a.out, exist_ok=True)

    print(f"extracting brand from {a.url} ...")
    brief = extract(a.url)
    name = a.name or (brief["title"].split("|")[0].split("-")[0].strip() or brief["domain"])
    brief["name"] = name

    logo_uri = None
    if brief["logo"]:
        try:
            blob = fetch(brief["logo"], binary=True)
            ext = brief["logo"].rsplit(".", 1)[-1].lower().split("?")[0]
            mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                    "svg": "image/svg+xml", "webp": "image/webp"}.get(ext, "image/png")
            logo_uri = f"data:{mime};base64," + base64.b64encode(blob).decode()
        except Exception as e:
            print(f"  (logo fetch failed: {e}; using text wordmark)")

    with open(os.path.join(a.out, "brief.json"), "w") as fh:
        json.dump(brief, fh, indent=2)
    print(f"  palette {brief['palette']}  phone {brief['phone'] or '-'}  "
          f"logo {'yes' if logo_uri else 'wordmark'}  socials {len(brief['socials'])}")

    print(f"drafting {a.posts} posts ...")
    posts = draft_posts(brief, name, a.posts)
    with open(os.path.join(a.out, "posts.json"), "w") as fh:
        json.dump(posts, fh, indent=2)

    for i, p in enumerate(posts, 1):
        png = os.path.join(a.out, f"sample-{i}-{p['slug']}.png")
        render(name, card_html(p, brief, name, logo_uri), png, chrome)
        print(f"  {os.path.basename(png)}")
    print(f"\n{len(posts)} samples in {a.out} — AUDIT EVERY CARD before a prospect sees it.")


if __name__ == "__main__":
    main()
