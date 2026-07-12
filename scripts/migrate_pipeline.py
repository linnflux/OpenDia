#!/usr/bin/env python3
"""
migrate_pipeline.py — FluxCC Migration Pipeline

Crawls a live website and migrates it to Astro + Cloudflare Pages + GitLab,
preserving content and brand while applying FluxCC's design system.

Usage:
  python3 migrate_pipeline.py migrate <url> [--name NAME] [--variant VARIANT]
                                             [--force-crawl] [--skip-deploy] [--dry-run]
  python3 migrate_pipeline.py resume <slug> [--from-stage N]
"""

import argparse
import asyncio
import base64
import colorsys
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

# ── Shared imports from intake_pipeline ──────────────────────────────────────

sys.path.insert(0, str(Path(__file__).parent))
import intake_pipeline as ip

DB_PATH             = ip.DB_PATH
REPOS_ROOT          = ip.REPOS_ROOT
DEBUG_DIR           = ip.DEBUG_DIR
GLAB_PATH           = ip.GLAB_PATH
SCRIPTS_DIR         = ip.SCRIPTS_DIR
CF_EMAIL            = ip.CF_EMAIL
BUILD_REGISTRY_TABLE_ID = ip.BUILD_REGISTRY_TABLE_ID

# ── New constants ─────────────────────────────────────────────────────────────

GEMINI_API_KEY_PATH  = Path.home() / ".claude" / "mcp-credentials" / "gemini" / "api_key"
GEMINI_API_BASE      = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_TEXT_MODEL    = "gemini-flash-latest"
GOOGLE_FONTS_CSS_BASE = "https://fonts.googleapis.com/css2"
FALLBACK_HEADING_FONT = "Poppins"
FALLBACK_BODY_FONT    = "Open Sans"

VARIANT_KEYWORDS = {
    "fluxcc-legal":  ["law", "legal", "attorney", "counsel", "litigation", "court", "esquire"],
    "fluxcc-author": ["author", "writer", "book", "novel", "poetry", "memoir", "publisher"],
}

# ── FluxCC component assets injected during step 6g2 ─────────────────────────

COMPONENTS_CSS = """\
/* FluxCC Component Library — inline prose components */
/* Usage: HTML blocks in markdown. Leave blank lines before/after.
   Inside divs, use <p> and <strong> tags, not markdown syntax. */

.callout {
  border-left: 4px solid var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  border-radius: 0 var(--radius) var(--radius) 0;
  padding: var(--space-4) var(--space-6);
  margin: var(--space-6) 0;
}
.callout--info {
  border-left-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
}
.callout--warning { border-left-color: #d97706; background: #fffbeb; }
.callout p:last-child { margin-bottom: 0; }

.pullquote {
  border-left: 4px solid var(--color-accent);
  color: var(--color-primary);
  font-size: var(--text-xl);
  font-style: italic;
  padding: var(--space-4) var(--space-6);
  margin: var(--space-8) 0;
  line-height: var(--leading-relaxed);
}
.pullquote p:last-child { margin-bottom: 0; }

.columns-2 { display: grid; grid-template-columns: 1fr; gap: var(--space-6); margin: var(--space-6) 0; }
@media (min-width: 640px) { .columns-2 { grid-template-columns: 1fr 1fr; } }

.stat-bar {
  display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-8);
  border-top: 2px solid var(--color-border, #e2e8f0);
  border-bottom: 2px solid var(--color-border, #e2e8f0);
  padding: var(--space-8) 0; margin: var(--space-8) 0; text-align: center;
}
.stat-bar__item { display: flex; flex-direction: column; align-items: center; gap: var(--space-1); }
.stat-bar__number {
  font-family: var(--font-heading); font-size: var(--text-4xl);
  font-weight: 700; color: var(--color-primary); line-height: 1;
}
.stat-bar__label {
  font-size: var(--text-xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-muted);
}

.prose-section-alt {
  background: var(--color-bg-alt, #f7f8fa);
  border-radius: var(--radius);
  padding: var(--space-8) var(--space-6);
  margin: var(--space-8) calc(-1 * var(--space-6));
}
"""

CTABAND_ASTRO = """\
---
interface Props {
  heading?: string;
  text?: string;
  primaryLabel: string;
  primaryHref: string;
  secondaryLabel?: string;
  secondaryHref?: string;
}
const {
  heading = "Ready to Take the Next Step?",
  text = "Contact us to learn how we can help.",
  primaryLabel,
  primaryHref,
  secondaryLabel = "Contact Us",
  secondaryHref = "/contact",
} = Astro.props;
---
<section class="cta-strip">
  <div class="container text-center">
    <h2>{heading}</h2>
    <p>{text}</p>
    <div class="cta-strip__buttons">
      <a href={primaryHref} class="btn btn-accent">{primaryLabel}</a>
      <a href={secondaryHref} class="btn btn-outline-white">{secondaryLabel}</a>
    </div>
  </div>
</section>
<style>
  .cta-strip { background-color: var(--color-primary); color: #fff; padding: var(--space-16) 0; }
  .cta-strip h2 { color: #fff; margin-bottom: var(--space-4); }
  .cta-strip p { color: rgba(255,255,255,0.85); font-size: var(--text-lg); margin-bottom: var(--space-8); }
  .cta-strip__buttons { display: flex; gap: var(--space-4); justify-content: center; flex-wrap: wrap; }
  .btn-accent {
    background-color: var(--color-accent); color: var(--color-text); font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em; border: 2px solid transparent;
    padding: var(--space-4) var(--space-8); border-radius: var(--radius);
    text-decoration: none; display: inline-flex; align-items: center; transition: background-color 0.15s;
  }
  .btn-accent:hover { background-color: var(--color-accent-dk); color: var(--color-text); }
  .btn-outline-white {
    background-color: transparent; color: #fff; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em; border: 2px solid rgba(255,255,255,0.7);
    padding: var(--space-4) var(--space-8); border-radius: var(--radius);
    text-decoration: none; display: inline-flex; align-items: center;
    transition: border-color 0.15s, background-color 0.15s;
  }
  .btn-outline-white:hover { border-color: #fff; background-color: rgba(255,255,255,0.1); color: #fff; }
</style>
"""

_STATE_ABBREV_TO_NAME = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia",
}

# ── Manifest helpers ──────────────────────────────────────────────────────────

def _manifest_path(slug):
    return DEBUG_DIR / f"migrate-{slug}" / "crawl-manifest.json"

def _save_manifest(manifest, debug_dir):
    path = Path(debug_dir) / "crawl-manifest.json"
    # Exclude large CSS blob from saved JSON to keep file manageable
    save_copy = {k: v for k, v in manifest.items() if k != "_css_text"}
    path.write_text(json.dumps(save_copy, indent=2))

def _load_manifest(slug):
    p = _manifest_path(slug)
    if not p.exists():
        raise FileNotFoundError(f"No manifest for slug '{slug}' at {p}")
    return json.loads(p.read_text())

# ── Gemini text helper ────────────────────────────────────────────────────────

def load_gemini_api_key():
    if not GEMINI_API_KEY_PATH.exists():
        raise FileNotFoundError(f"Gemini API key not found at {GEMINI_API_KEY_PATH}")
    return GEMINI_API_KEY_PATH.read_text().strip()


def gemini_text_with_image(prompt, image_paths=None):
    """Call gemini-2.0-flash for a text response, optionally including images."""
    api_key = load_gemini_api_key()
    parts = []
    for img_path in (image_paths or []):
        p = Path(img_path)
        if not p.exists():
            continue
        mime, _ = mimetypes.guess_type(str(p))
        if not mime or not mime.startswith("image/"):
            continue
        data = base64.b64encode(p.read_bytes()).decode("ascii")
        parts.append({"inlineData": {"mimeType": mime, "data": data}})
    parts.append({"text": prompt})

    payload = {"contents": [{"parts": parts}]}
    url = f"{GEMINI_API_BASE}/{GEMINI_TEXT_MODEL}:generateContent"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-goog-api-key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini API {e.code}: {detail[:400]}")

    candidates = result.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"No Gemini candidates: {json.dumps(result)[:300]}")
    parts_out = candidates[0].get("content", {}).get("parts", []) or []
    return "".join(part.get("text", "") for part in parts_out).strip()


def _parse_city_state(manifest):
    """Extract (city, state_abbrev) from manifest contact address or page paragraphs."""
    address = (manifest.get("contact") or {}).get("address", "") or ""
    m = re.search(r'([A-Za-z\s\-]+),\s*([A-Z]{2})(?:\s+\d{5})?', address)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    for page in manifest.get("pages", []):
        for para in page.get("paragraphs", []):
            m = re.search(r'([A-Za-z\s\-]+),\s*([A-Z]{2})(?:\s+\d{5})?', para)
            if m:
                return m.group(1).strip(), m.group(2).strip()
    return "", ""


def _generate_page_body(biz_name, slot, crawled_context):
    """Generate body markdown for a standard page slot via Gemini. Returns text or None."""
    prompts = {
        "about": (
            f"Write an About page for '{biz_name}' using markdown with HTML components.\n\n"
            f"Structure:\n"
            f"1. Opening paragraph establishing who they are\n"
            f"2. ## Our Mission heading + <blockquote class=\"pullquote\"> with mission statement\n"
            f"3. ## section about what sets them apart or who they serve\n"
            f"4. A <div class=\"stat-bar\"> with 2-3 stats (use general phrasing if no exact numbers are known)\n"
            f"5. ## section about approach or community involvement\n\n"
            f"Rules:\n"
            f"- Leave a blank line before and after any HTML block\n"
            f"- Inside HTML divs, use <p> and <strong> (not markdown syntax)\n"
            f"- Do not invent specific dates, staff names, or statistics not in the context\n"
            f"- Professional, warm tone. No first-person.\n\n"
            f"Context from other pages:\n{crawled_context}"
        ),
        "services": (
            f"Write a Services page for '{biz_name}' using markdown with HTML components.\n\n"
            f"Structure:\n"
            f"1. Opening paragraph introducing the service philosophy\n"
            f"2. For each major service category: ## heading, brief paragraph, bullet points\n"
            f"3. After the first service, insert: <div class=\"callout\"><p>Encouraging sentence about reaching out.</p></div>\n"
            f"4. Where two related sub-services exist, use: <div class=\"columns-2\"><div>Left</div><div>Right</div></div>\n\n"
            f"Rules:\n"
            f"- Leave a blank line before and after HTML blocks\n"
            f"- Inside HTML divs, use <p> and <strong> tags\n"
            f"- Do not invent prices or certifications\n"
            f"- Keep consistent with site context\n\n"
            f"Context:\n{crawled_context}"
        ),
        "contact": (
            f"Write Contact page body for '{biz_name}' using markdown.\n\n"
            f"Structure:\n"
            f"1. 2-3 welcoming sentences encouraging visitors to reach out\n"
            f"2. A <div class=\"callout\"><p>Hours or availability info if known, otherwise general welcome</p></div>\n"
            f"3. Brief sentence about response time\n\n"
            f"Keep concise — the form and map render separately below.\n"
            f"Context:\n{crawled_context}"
        ),
        "extra": (
            f"Rewrite this page content for '{biz_name}' using clean markdown. "
            f"Add ## headings to break up sections. Use <div class=\"callout\">...</div> for key takeaways. "
            f"Keep all factual content but improve readability and structure.\n"
            f"Original content:\n{crawled_context}"
        ),
    }
    prompt = prompts.get(slot)
    if not prompt:
        return None
    try:
        return gemini_text_with_image(prompt)
    except Exception as e:
        print(f"  [warn] Gemini body for {slot}: {e}", file=sys.stderr)
        return None


# ── Stage 1: Crawl & Extract ──────────────────────────────────────────────────

async def _crawl_async(start_url, max_pages=20, max_depth=2):
    """Playwright async BFS crawl. Returns list of page dicts."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise RuntimeError("playwright not installed: pip install playwright && playwright install chromium")

    parsed    = urllib.parse.urlparse(start_url)
    base_domain = parsed.netloc
    visited   = set()
    queue     = [(start_url, 0)]
    pages     = []

    SOCIAL_DOMAINS = {
        "facebook": "facebook.com", "twitter": "twitter.com",
        "instagram": "instagram.com", "linkedin": "linkedin.com",
        "youtube": "youtube.com", "tiktok": "tiktok.com",
        "pinterest": "pinterest.com",
    }

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()

        while queue and len(pages) < max_pages:
            url, depth = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)

            pg = await browser.new_page(
                viewport={"width": 1280, "height": 800},
                user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 OpenDia-migrate/1.0",
            )
            page_data = {"url": url, "depth": depth}

            try:
                await pg.goto(url, timeout=15000, wait_until="domcontentloaded")
                await pg.wait_for_timeout(600)

                page_data["title"] = await pg.title()

                page_data["meta_description"] = await pg.evaluate("""
                    () => {
                        const m = document.querySelector(
                            'meta[name="description"], meta[property="og:description"]');
                        return m ? (m.getAttribute('content') || '') : '';
                    }
                """)

                page_data["headings"] = await pg.evaluate("""
                    () => {
                        const out = [];
                        document.querySelectorAll('h1,h2,h3').forEach(el => {
                            const t = el.innerText.trim();
                            if (t) out.push({level: el.tagName.toLowerCase(), text: t});
                        });
                        return out;
                    }
                """)

                page_data["paragraphs"] = await pg.evaluate("""
                    () => Array.from(document.querySelectorAll('p'))
                        .map(el => el.innerText.trim())
                        .filter(t => t.length > 30)
                        .slice(0, 20)
                """)

                page_data["images"] = await pg.evaluate("""
                    () => Array.from(document.querySelectorAll('img'))
                        .map(el => ({
                            src: el.src, alt: el.alt || '',
                            width: el.naturalWidth || el.width || 0,
                            height: el.naturalHeight || el.height || 0
                        }))
                        .filter(i => i.src && i.src.startsWith('http') && !i.src.startsWith('data:'))
                        .slice(0, 30)
                """)

                bd_js = json.dumps(base_domain)
                all_links = await pg.evaluate(f"""
                    () => {{
                        const bd = {bd_js};
                        return Array.from(document.querySelectorAll('a[href]'))
                            .map(a => a.href)
                            .filter(href => {{
                                try {{ return new URL(href).hostname === bd; }}
                                catch(e) {{ return false; }}
                            }});
                    }}
                """)

                # Normalize links and enqueue
                norm_links = set()
                for link in all_links:
                    plink = urllib.parse.urlparse(link)
                    clean = urllib.parse.urlunparse(plink._replace(fragment="", query=""))
                    norm_links.add(clean)
                if depth < max_depth:
                    for u in sorted(norm_links):
                        if u not in visited:
                            queue.append((u, depth + 1))

                # Social links from all hrefs
                social_links = []
                seen_platforms = set()
                for link in all_links:
                    for platform, domain in SOCIAL_DOMAINS.items():
                        if domain in link.lower() and platform not in seen_platforms:
                            social_links.append({"platform": platform, "url": link})
                            seen_platforms.add(platform)
                page_data["social_links"] = social_links

                # Contact extraction from text
                text_content = await pg.evaluate("() => document.body.innerText")
                phone_m = re.search(r'(?:\+1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}', text_content)
                page_data["phone"] = phone_m.group(0).strip() if phone_m else ""
                email_m = re.search(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}', text_content)
                page_data["email"] = email_m.group(0) if email_m else ""
                addr_m = re.search(
                    r'\d{1,5}\s+[A-Za-z][A-Za-z\s]{2,30}(?:Street|St|Avenue|Ave|Road|Rd|'
                    r'Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl)\b',
                    text_content, re.IGNORECASE
                )
                page_data["address"] = addr_m.group(0).strip() if addr_m else ""
                hours_m = re.search(
                    r'(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s*(?:[-–]\s*'
                    r'(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))',
                    text_content
                )
                page_data["hours_text"] = hours_m.group(0).strip() if hours_m else ""

                # Computed colors from key elements
                page_data["computed_colors"] = await pg.evaluate("""
                    () => {
                        const counts = {};
                        const sel = 'header,nav,section,.hero,.btn,button,h1,h2,h3,' +
                            '[class*="primary"],[class*="accent"],[class*="brand"]';
                        document.querySelectorAll(sel).forEach(el => {
                            const s = window.getComputedStyle(el);
                            ['backgroundColor','color','borderColor'].forEach(prop => {
                                const v = s[prop];
                                if (v && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent') {
                                    counts[v] = (counts[v] || 0) + 1;
                                }
                            });
                        });
                        return counts;
                    }
                """)

                # Logo detection
                page_data["logo_candidate"] = await pg.evaluate("""
                    () => {
                        const sels = [
                            'header img','nav img','.logo img','#logo img',
                            'img[class*="logo"]','a[class*="logo"] img',
                            '.navbar-brand img','.site-logo img','[id*="logo"] img'
                        ];
                        for (const sel of sels) {
                            const el = document.querySelector(sel);
                            if (el && el.src && el.src.startsWith('http')) {
                                return {src: el.src, alt: el.alt || ''};
                            }
                        }
                        return null;
                    }
                """)

            except Exception as e:
                page_data["error"] = str(e)
                print(f"  [warn] crawl {url}: {e}", file=sys.stderr)
            finally:
                await pg.close()

            pages.append(page_data)
            print(f"  [{len(pages)}/{max_pages}] {url}")

        await browser.close()

    return pages


def stage1_crawl(slug, source_url, force=False):
    debug_dir = DEBUG_DIR / f"migrate-{slug}"
    debug_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = debug_dir / "crawl-manifest.json"

    if manifest_path.exists() and not force:
        print("  Manifest exists — loading. Use --force-crawl to re-crawl.")
        m = json.loads(manifest_path.read_text())
        m["_debug_dir"] = str(debug_dir)
        return m

    print(f"  Crawling {source_url} (max 20 pages, depth 2)...")
    pages = asyncio.run(_crawl_async(source_url, max_pages=20, max_depth=2))

    # Download images
    images_dir = debug_dir / "images"
    images_dir.mkdir(exist_ok=True)
    seen_srcs, all_images = set(), []
    for page in pages:
        for img in page.get("images", []):
            if img["src"] not in seen_srcs:
                seen_srcs.add(img["src"])
                all_images.append(img)

    downloaded_images = []
    for i, img in enumerate(all_images[:50]):
        try:
            path_part = urllib.parse.urlparse(img["src"]).path
            ext = Path(path_part).suffix[:6].lower()
            if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"):
                ext = ".jpg"
            dest = images_dir / f"image-{i:03d}{ext}"
            ip.download_file(img["src"], dest)
            downloaded_images.append({**img, "local_path": str(dest)})
        except Exception as e:
            downloaded_images.append(img)

    # Download logo
    logo_local = None
    for page in pages:
        if page.get("logo_candidate"):
            try:
                src = page["logo_candidate"]["src"]
                ext = Path(urllib.parse.urlparse(src).path).suffix[:6].lower()
                if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"):
                    ext = ".png"
                logo_dest = debug_dir / f"logo-source{ext}"
                ip.download_file(src, logo_dest)
                logo_local = str(logo_dest)
                print(f"  Logo → {logo_dest.name}")
                break
            except Exception as e:
                print(f"  [warn] logo download: {e}", file=sys.stderr)

    # Aggregate contact / social
    phone = email = address = hours = ""
    all_social: dict = {}
    for page in pages:
        if not phone and page.get("phone"):
            phone = page["phone"]
        if not email and page.get("email"):
            email = page["email"]
        if not address and page.get("address"):
            address = page["address"]
        if not hours and page.get("hours_text"):
            hours = page["hours_text"]
        for item in page.get("social_links", []):
            all_social.setdefault(item["platform"], item["url"])

    # Detect business name from homepage title
    biz_name_detected = ""
    if pages:
        title = pages[0].get("title", "")
        biz_name_detected = re.sub(
            r'\s*[\|–—\-]\s*(?:Home|Welcome|Index|Main).*$', '', title, flags=re.IGNORECASE
        ).strip() or title.strip()

    manifest = {
        "source_url": source_url,
        "slug": slug,
        "biz_name_detected": biz_name_detected,
        "crawled_at": datetime.now(timezone.utc).isoformat(),
        "pages": pages,
        "images": downloaded_images,
        "logo_local": logo_local,
        "contact": {"phone": phone, "email": email, "address": address, "hours": hours},
        "social_links": [{"platform": k, "url": v} for k, v in all_social.items()],
        "brand": {},
        "fonts": {},
        "page_map": [],
        "service_cards": [],
        "gmail_id": "",
        "stage_completed": 1,
    }

    _save_manifest(manifest, debug_dir)
    manifest["_debug_dir"] = str(debug_dir)
    print(f"  Stage 1 done: {len(pages)} pages, {len(downloaded_images)} images")
    return manifest


# ── Stage 2: Brand Analysis ───────────────────────────────────────────────────

def _parse_rgb_str(rgb_str):
    m = re.match(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)', rgb_str)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None

def _hex_to_rgb(hex_color):
    h = hex_color.lstrip('#')
    if len(h) == 3:
        h = h[0]*2 + h[1]*2 + h[2]*2
    if len(h) == 6:
        try:
            return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        except ValueError:
            pass
    return None

def _rgb_to_hex(r, g, b):
    return f"#{r:02x}{g:02x}{b:02x}"

def _rgb_dist(c1, c2):
    return ((c1[0]-c2[0])**2 + (c1[1]-c2[1])**2 + (c1[2]-c2[2])**2) ** 0.5

def _is_noise(r, g, b):
    """True if color is near-white, near-black, or gray (not a brand color)."""
    brightness = (r + g + b) / 3
    if brightness > 228 or brightness < 28:
        return True
    spread = max(r, g, b) - min(r, g, b)
    return spread < 22

def _darken_hex(hex_color, percent=15):
    rgb = _hex_to_rgb(hex_color)
    if not rgb:
        return hex_color
    h, s, v = colorsys.rgb_to_hsv(rgb[0]/255, rgb[1]/255, rgb[2]/255)
    v = max(0.0, v * (1 - percent / 100))
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return _rgb_to_hex(int(r*255), int(g*255), int(b*255))

def _pick_brand_colors(color_counts):
    filtered = {}
    for h, cnt in color_counts.items():
        rgb = _hex_to_rgb(h)
        if rgb and not _is_noise(*rgb):
            filtered[h] = cnt

    if not filtered:
        return None, None, None

    sorted_colors = sorted(filtered.items(), key=lambda x: -x[1])

    # Group similar colors
    groups = []
    for hex_color, count in sorted_colors:
        rgb = _hex_to_rgb(hex_color)
        merged = False
        for grp in groups:
            if _rgb_dist(rgb, _hex_to_rgb(grp["hex"])) < 30:
                grp["count"] += count
                merged = True
                break
        if not merged:
            groups.append({"hex": hex_color, "count": count})

    groups.sort(key=lambda x: -x["count"])
    primary  = groups[0]["hex"] if groups else None
    accent   = groups[1]["hex"] if len(groups) > 1 else None
    accent_dk = groups[2]["hex"] if len(groups) > 2 else (_darken_hex(accent) if accent else None)
    return primary, accent, accent_dk


def stage2_brand(manifest, debug_dir):
    print("  Stage 2: Brand analysis...")
    debug_dir = Path(debug_dir)

    # Aggregate computed colors
    combined: dict = {}
    for page in manifest.get("pages", []):
        for color_str, count in page.get("computed_colors", {}).items():
            rgb = _parse_rgb_str(color_str)
            if rgb:
                h = _rgb_to_hex(*rgb)
                combined[h] = combined.get(h, 0) + count

    primary, accent, accent_dk = _pick_brand_colors(combined)

    if not primary or not accent:
        print("  < 2 distinct brand colors — trying Gemini visual extraction...")
        try:
            ss_path = debug_dir / "homepage-screenshot.png"
            if not ss_path.exists():
                ip.screenshot_url(manifest["source_url"], ss_path)
            result_text = gemini_text_with_image(
                "Analyze this website screenshot. Identify the 2-3 primary brand colors "
                "(exclude white, black, and gray). Return ONLY a JSON object with keys "
                "'primary_hex', 'accent_hex', 'accent_dark_hex' as #RRGGBB hex strings. "
                'Example: {"primary_hex":"#1a4a8f","accent_hex":"#e85d1e","accent_dark_hex":"#c44d18"}',
                [str(ss_path)],
            )
            json_m = re.search(r'\{[^}]+\}', result_text, re.DOTALL)
            if json_m:
                colors = json.loads(json_m.group(0))
                primary   = colors.get("primary_hex", "#2d3748")
                accent    = colors.get("accent_hex", "#4a90e2")
                accent_dk = colors.get("accent_dark_hex") or _darken_hex(accent)
        except Exception as e:
            print(f"  [warn] Gemini color fallback: {e}", file=sys.stderr)

    primary   = primary   or "#2d3748"
    accent    = accent    or "#4a90e2"
    accent_dk = accent_dk or _darken_hex(accent)

    manifest["brand"] = {
        "primary_hex":    primary,
        "accent_hex":     accent,
        "accent_dark_hex": accent_dk,
    }
    manifest["stage_completed"] = 2
    print(f"  Brand: {primary} / {accent} / {accent_dk}")
    _save_manifest(manifest, debug_dir)
    return manifest


# ── Stage 3: Font Pairing ─────────────────────────────────────────────────────

def _validate_google_font(font_name):
    try:
        family = urllib.parse.quote(font_name.replace(" ", "+"))
        url = f"{GOOGLE_FONTS_CSS_BASE}?family={family}:wght@400;600;700"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 OpenDia/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


def stage3_fonts(manifest, debug_dir):
    print("  Stage 3: Font pairing...")
    debug_dir = Path(debug_dir)
    brand = manifest.get("brand", {})
    logo_local = manifest.get("logo_local")

    # Step 3a: Logo analysis
    logo_analysis = ""
    if logo_local and Path(logo_local).exists():
        try:
            logo_analysis = gemini_text_with_image(
                "Analyze this logo image and describe its typography characteristics in under 80 words. "
                "Include: font style (serif/sans-serif/slab/script/decorative), personality "
                "(modern/traditional/playful/elegant/bold), weight impression, and letterform geometry.",
                [logo_local],
            )
            print(f"  Logo analysis: {logo_analysis[:80]}...")
        except Exception as e:
            print(f"  [warn] logo analysis: {e}", file=sys.stderr)

    # Step 3b: Font selection
    biz_name = manifest.get("biz_name_detected", "")
    content_sample = " ".join(
        p for page in manifest.get("pages", [])[:3]
        for p in page.get("paragraphs", [])[:2]
    )[:400]
    source_url = manifest.get("source_url", "")
    content_lower = (content_sample + " " + source_url).lower()

    biz_type = "general business"
    for variant, kws in VARIANT_KEYWORDS.items():
        if any(kw in content_lower for kw in kws):
            biz_type = variant.replace("fluxcc-", "")
            break

    font_prompt = (
        f"You are a web typography expert. Select a Google Fonts heading + body font pair "
        f"for a {biz_type} website.\n"
        f"Business: {biz_name}\n"
        f"Primary color: {brand.get('primary_hex','#2d3748')}, "
        f"Accent: {brand.get('accent_hex','#4a90e2')}\n"
    )
    if logo_analysis:
        font_prompt += f"Logo typography: {logo_analysis}\n"
    font_prompt += (
        "\nRequirements: both fonts on Google Fonts, both have weights 400/600/700, "
        "heading is strong/distinctive, body is highly readable.\n\n"
        "Return ONLY valid JSON:\n"
        '{"heading_font":"Font Name","body_font":"Font Name",'
        '"heading_weights":[400,600,700],"body_weights":[400,600,700],'
        '"reasoning":"One sentence."}'
    )

    heading_font   = FALLBACK_HEADING_FONT
    body_font      = FALLBACK_BODY_FONT
    heading_weights = [400, 600, 700]
    body_weights    = [400, 600, 700]
    reasoning       = "Default pairing (Gemini unavailable)"

    try:
        resp_text = gemini_text_with_image(font_prompt)
        json_m = re.search(r'\{.*\}', resp_text, re.DOTALL)
        if json_m:
            fd = json.loads(json_m.group(0))
            heading_font    = fd.get("heading_font", FALLBACK_HEADING_FONT)
            body_font       = fd.get("body_font", FALLBACK_BODY_FONT)
            heading_weights = fd.get("heading_weights", [400, 600, 700])
            body_weights    = fd.get("body_weights", [400, 600, 700])
            reasoning       = fd.get("reasoning", "")
        print(f"  Fonts proposed: {heading_font} / {body_font}")
    except Exception as e:
        print(f"  [warn] font selection: {e}", file=sys.stderr)

    # Step 3c: Validate
    if not _validate_google_font(heading_font):
        print(f"  [warn] '{heading_font}' not on Google Fonts → {FALLBACK_HEADING_FONT}")
        heading_font = FALLBACK_HEADING_FONT
    if not _validate_google_font(body_font):
        print(f"  [warn] '{body_font}' not on Google Fonts → {FALLBACK_BODY_FONT}")
        body_font = FALLBACK_BODY_FONT

    manifest["fonts"] = {
        "heading_font":    heading_font,
        "body_font":       body_font,
        "heading_weights": heading_weights,
        "body_weights":    body_weights,
        "logo_analysis":   logo_analysis,
        "reasoning":       reasoning,
    }
    manifest["stage_completed"] = 3
    print(f"  Fonts confirmed: {heading_font} + {body_font}")
    _save_manifest(manifest, debug_dir)
    return manifest


# ── Stage 4: Page Mapping ─────────────────────────────────────────────────────

def _map_path_to_slot(path):
    path = path.rstrip("/").lower()
    if path in ("", "/", "/home", "/index", "/index.html", "/index.php"):
        return "home"
    patterns = [
        (r'^/about',           "about"),
        (r'^/our[- ]story',    "about"),
        (r'^/who[- ]we[- ]are', "about"),
        (r'^/team',            "about"),
        (r'^/services',        "services"),
        (r'^/what[- ]we[- ]do', "services"),
        (r'^/products',        "services"),
        (r'^/offerings',       "services"),
        (r'^/contact',         "contact"),
        (r'^/get[- ]in[- ]touch', "contact"),
        (r'^/reach[- ]us',     "contact"),
        (r'^/connect',         "contact"),
    ]
    for pattern, slot in patterns:
        if re.match(pattern, path):
            return slot
    parts = [p for p in path.split("/") if p]
    return parts[-1] if parts else "extra"


def _headings_to_md(headings, skip_h1=True):
    lines = []
    for h in headings:
        level = int(h["level"][1]) if len(h["level"]) == 2 and h["level"][1].isdigit() else 2
        if level == 1 and skip_h1:
            continue
        lines.append(f"{'#' * level} {h['text'].strip()}")
    return "\n\n".join(lines)


def _extract_service_cards(pages):
    cards = []
    for page in pages:
        headings = [h for h in page.get("headings", []) if h["level"] in ("h2", "h3")]
        paragraphs = page.get("paragraphs", [])
        for i, h in enumerate(headings[:8]):
            title = h["text"].strip()
            if not title or len(title) > 80:
                continue
            desc = paragraphs[i] if i < len(paragraphs) else ""
            if len(desc) > 200:
                desc = desc[:197] + "..."
            cards.append({"title": title, "description": desc})
            if len(cards) >= 6:
                return cards
    return cards[:6]


def stage4_page_map(manifest, debug_dir):
    print("  Stage 4: Page mapping...")
    debug_dir = Path(debug_dir)
    pages = manifest.get("pages", [])

    page_map = []
    slots_used = set()

    for page in pages:
        url = page.get("url", "")
        path = urllib.parse.urlparse(url).path
        slot = _map_path_to_slot(path)

        # First match wins for standard slots
        if slot in ("home", "about", "services", "contact") and slot in slots_used:
            continue

        title = page.get("title", "")
        title_clean = re.sub(r'\s*[\|–—\-]\s*.+$', '', title, count=1).strip() or title.strip()

        h1s = [h["text"] for h in page.get("headings", []) if h["level"] == "h1"]
        hero_heading = h1s[0] if h1s else title_clean

        meta_desc = page.get("meta_description", "")
        if len(meta_desc) > 160:
            meta_desc = meta_desc[:157] + "..."
        if not meta_desc:
            paras = page.get("paragraphs", [])
            meta_desc = (paras[0][:157] + "...") if paras else ""

        body_md_parts = []
        h_md = _headings_to_md(page.get("headings", []), skip_h1=True)
        if h_md:
            body_md_parts.append(h_md)
        for p in page.get("paragraphs", [])[:10]:
            body_md_parts.append(p)
        body_md = "\n\n".join(body_md_parts)

        page_map.append({
            "slot":           slot,
            "source_url":     url,
            "source_path":    path,
            "title":          title_clean,
            "meta_description": meta_desc,
            "heroHeading":    hero_heading,
            "body_markdown":  body_md,
            "is_extra_page":  slot not in ("home", "about", "services", "contact"),
        })
        slots_used.add(slot)

    service_cards = _extract_service_cards(pages)

    manifest["page_map"]     = page_map
    manifest["service_cards"] = service_cards
    manifest["stage_completed"] = 4

    print(f"  Page map: {len(page_map)} pages, {len(service_cards)} service cards")
    _save_manifest(manifest, debug_dir)
    return manifest


# ── Stage 5: Tracking Setup ───────────────────────────────────────────────────

def stage5_tracking(manifest, biz_name, slug, debug_dir):
    print("  Stage 5: Tracking setup...")
    debug_dir = Path(debug_dir)
    source_url = manifest.get("source_url", "")
    source_domain = urllib.parse.urlparse(source_url).netloc
    gmail_id = f"migrate:{slug}:{source_domain}"

    notes = f"migration from {source_url}; biz={biz_name}"
    inbox_id = ip.upsert_inbox_row(
        gmail_id=gmail_id, from_addr="",
        subject=f"[migrate] {biz_name}", status="migrating",
        client_hint=slug, division_hint="WordFlux", notes=notes,
    )
    print(f"  Inbox row id={inbox_id}")

    try:
        if not ip.find_registry_row_id(slug):
            ip.append_registry_row(client=biz_name, slug=slug, status="migrating")
            print(f"  Registry row appended.")
        else:
            print(f"  Registry row exists.")
    except Exception as e:
        print(f"  [warn] Registry: {e}", file=sys.stderr)

    try:
        task_body = (
            f"Migration from: {source_url}\n"
            f"Business: {biz_name}\n"
            f"Slug: {slug}\n"
            f"Pages: {len(manifest.get('page_map', []))}\n"
            f"Brand: {manifest.get('brand', {})}\n"
            f"Fonts: heading={manifest.get('fonts', {}).get('heading_font')} "
            f"body={manifest.get('fonts', {}).get('body_font')}\n"
        )
        ip.create_notion_task(f"[migrate] {biz_name}", task_body)
        print("  Notion task created.")
    except Exception as e:
        print(f"  [warn] Notion task: {e}", file=sys.stderr)

    manifest["gmail_id"] = gmail_id
    manifest["stage_completed"] = 5
    _save_manifest(manifest, debug_dir)
    return manifest


# ── Stage 6: Scaffold & Populate ─────────────────────────────────────────────

def _infer_variant(manifest):
    pages = manifest.get("pages", [])
    content = " ".join(
        p for page in pages[:5]
        for p in page.get("paragraphs", [])[:3]
    ).lower()
    content += " " + manifest.get("source_url", "").lower()
    for variant, kws in VARIANT_KEYWORDS.items():
        if any(kw in content for kw in kws):
            return variant
    return "fluxcc-business"


def _build_google_fonts_url(heading_font, body_font, heading_weights, body_weights):
    def encode(name, weights):
        fam = name.replace(" ", "+")
        wts = ";".join(str(w) for w in sorted(weights))
        return f"family={fam}:wght@{wts}"
    return (
        f"https://fonts.googleapis.com/css2?"
        f"{encode(heading_font, heading_weights)}&"
        f"{encode(body_font, body_weights)}&display=swap"
    )


def stage6_scaffold(manifest, biz_name, slug, debug_dir, variant=None, dry_run=False):
    print("  Stage 6: Scaffold & populate...")
    debug_dir = Path(debug_dir)

    # 6a: Infer template variant
    variant = variant or _infer_variant(manifest)
    print(f"  Variant: {variant}")

    repo_path = REPOS_ROOT / slug
    template_origin = f"git@gitlab.com:flux-cc/{variant}.git"

    # 6b: Clone template
    if not (repo_path / ".git").exists():
        if dry_run:
            print(f"  [dry-run] would clone {template_origin}")
        else:
            print(f"  Cloning {template_origin}...")
            ip._git(["git", "clone", template_origin, str(repo_path)], REPOS_ROOT)
    else:
        print(f"  Repo already at {repo_path}")

    if dry_run:
        manifest["variant"] = variant
        manifest["stage_completed"] = 6
        _save_manifest(manifest, debug_dir)
        return manifest

    brand   = manifest.get("brand", {})
    fonts   = manifest.get("fonts", {})
    contact = manifest.get("contact", {})
    data_json = "src/content/business/data.json"

    # 6c: data.json scalars
    phone_raw = contact.get("phone", "")
    scalars = {
        "name":    biz_name,
        "phone":   ip._fmt_phone_display(phone_raw) if phone_raw else None,
        "email":   contact.get("email") or None,
        "address": contact.get("address") or None,
        "hours":   contact.get("hours") or None,
    }
    for field, val in scalars.items():
        if val:
            try:
                ip.run_edit_field(repo_path, data_json, field, val)
            except Exception as e:
                print(f"  [warn] data.json {field}: {e}", file=sys.stderr)

    social_links = manifest.get("social_links", [])
    if social_links:
        try:
            ip._patch_json_array(repo_path / data_json, "socialLinks", social_links)
        except Exception as e:
            print(f"  [warn] socialLinks: {e}", file=sys.stderr)

    # 6d: Page content
    page_map = manifest.get("page_map", [])
    SLOT_FILES = {
        "home":     "src/content/pages/home.md",
        "about":    "src/content/pages/about.md",
        "services": "src/content/pages/services.md",
        "contact":  "src/content/pages/contact.md",
    }

    for entry in page_map:
        slot     = entry["slot"]
        is_extra = entry.get("is_extra_page", False)

        if is_extra:
            # Create new extra page
            extra_slug = ip.slugify(entry.get("title") or entry["source_path"].strip("/").replace("/", "-"))
            file_rel   = f"src/content/pages/{extra_slug}.md"
            dest_path  = repo_path / file_rel
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            fm = (
                "---\n"
                f'title: "{entry["title"]}"\n'
                f'description: "{entry["meta_description"]}"\n'
                f'heroHeading: "{entry["heroHeading"]}"\n'
                "---\n\n"
            )
            extra_body = entry.get("body_markdown", "")
            if len(extra_body.strip()) > 200:
                enhanced = _generate_page_body(biz_name, "extra", extra_body)
                if enhanced:
                    extra_body = enhanced
            dest_path.write_text(fm + extra_body + "\n")
            print(f"  Extra page: {file_rel}")
            continue

        file_rel = SLOT_FILES.get(slot)
        if not file_rel:
            continue

        for field, val in [
            ("title",       entry["title"]),
            ("description", entry["meta_description"]),
            ("heroHeading", entry["heroHeading"]),
        ]:
            if val:
                try:
                    ip.run_edit_field(repo_path, file_rel, field, val)
                except Exception as e:
                    print(f"  [warn] {file_rel} {field}: {e}", file=sys.stderr)

        # Inject body markdown
        body_md = entry.get("body_markdown", "").strip()
        if body_md:
            dest_path = repo_path / file_rel
            if dest_path.exists():
                try:
                    fm_end = ip._find_frontmatter_end(dest_path)
                    lines  = dest_path.read_text().splitlines(keepends=True)
                    dest_path.write_text("".join(lines[:fm_end]) + "\n" + body_md + "\n")
                except Exception as e:
                    print(f"  [warn] body inject {file_rel}: {e}", file=sys.stderr)

    # 6d2: Gemini body generation for unmapped/empty/flat standard slots
    STANDARD_SLOTS = ("about", "services", "contact")
    mapped_with_body = {
        e["slot"] for e in page_map
        if not e.get("is_extra_page")
        and e.get("body_markdown", "").strip()
        and re.search(r'^#{1,3}\s', e.get("body_markdown", ""), re.MULTILINE)
    }
    unmapped_slots = [s for s in STANDARD_SLOTS if s not in mapped_with_body]
    if unmapped_slots:
        ctx_parts = [e.get("body_markdown", "").strip() for e in page_map if e.get("body_markdown", "").strip()]
        crawled_context = "\n\n".join(ctx_parts)[:3000]
        for slot in unmapped_slots:
            print(f"  Generating Gemini body for unmapped slot: {slot}")
            body_text = _generate_page_body(biz_name, slot, crawled_context)
            if not body_text:
                continue
            file_rel = SLOT_FILES.get(slot)
            if not file_rel:
                continue
            dest_path = repo_path / file_rel
            if dest_path.exists():
                try:
                    fm_end = ip._find_frontmatter_end(dest_path)
                    lines  = dest_path.read_text().splitlines(keepends=True)
                    dest_path.write_text("".join(lines[:fm_end]) + "\n" + body_text + "\n")
                    print(f"  Gemini body injected: {file_rel}")
                except Exception as e:
                    print(f"  [warn] Gemini body inject {file_rel}: {e}", file=sys.stderr)

    # 6e: index.astro service cards
    service_cards = manifest.get("service_cards", [])
    if service_cards:
        index_astro = repo_path / "src" / "pages" / "index.astro"
        if index_astro.exists():
            cards_js = json.dumps(service_cards, indent=2)
            try:
                ip.sed_replace(
                    index_astro,
                    r'const services\s*=\s*\[[\s\S]*?\];',
                    f"const services = {cards_js};",
                )
            except ValueError:
                pass  # Pattern not found — template may differ
            except Exception as e:
                print(f"  [warn] index.astro services: {e}", file=sys.stderr)

    # 6e2: index.astro copy rewrite — CTA strip, section subtitles, features, Hero.astro CTA
    index_astro_6e2 = repo_path / "src" / "pages" / "index.astro"
    hero_astro_6e2  = repo_path / "src" / "components" / "Hero.astro"

    # Build crawled context for Gemini
    ctx_snippets_6e2 = []
    for pg in manifest.get("pages", [])[:6]:
        for para in pg.get("paragraphs", [])[:3]:
            if para.strip():
                ctx_snippets_6e2.append(para.strip())
    crawled_ctx_6e2  = "\n".join(ctx_snippets_6e2[:12])
    existing_cards_6e2 = json.dumps(manifest.get("service_cards", []), indent=2)

    _6e2_fallbacks = {
        "cta_heading":         "Ready to Get Started?",
        "cta_paragraph":       "Contact us today to learn more about our services.",
        "cta_button":          "Contact Us",
        "services_subtitle":   "Professional services tailored to your needs.",
        "why_choose_subtitle": "Trusted by our community.",
        "features": [
            {"icon": "⭐", "title": "Quality Service", "text": "Delivering reliable, professional results for every client."},
            {"icon": "🤝", "title": "Client First",    "text": "Your satisfaction is our top priority."},
            {"icon": "📍", "title": "Local Experts",   "text": "Proudly serving our local community."},
        ],
    }
    copy_6e2 = dict(_6e2_fallbacks)

    try:
        prompt_6e2 = (
            f"Write marketing copy for a website for '{biz_name}'.\n"
            f"Existing service cards:\n{existing_cards_6e2}\n\n"
            f"Crawled site context:\n{crawled_ctx_6e2}\n\n"
            f"Return ONLY valid JSON (no markdown fences, no extra text) with these keys:\n"
            f"- cta_heading: punchy h2 (8 words max, no plumbing references)\n"
            f"- cta_paragraph: 1-2 sentences encouraging contact\n"
            f"- cta_button: short button label (2-4 words)\n"
            f"- services_subtitle: 1 sentence describing the range of services\n"
            f"- why_choose_subtitle: 1 sentence about reputation or trust\n"
            f"- features: array of 3 objects with keys 'icon' (single emoji), 'title' (3-5 words), 'text' (1-2 sentences)\n"
            f"All copy must be relevant to '{biz_name}'. No plumbing, estimates, or generic contractor language."
        )
        raw_6e2 = gemini_text_with_image(prompt_6e2)
        raw_6e2 = re.sub(r'^```(?:json)?\s*|\s*```$', '', raw_6e2.strip(), flags=re.MULTILINE)
        parsed_6e2 = json.loads(raw_6e2)
        for k in _6e2_fallbacks:
            if k in parsed_6e2 and parsed_6e2[k]:
                copy_6e2[k] = parsed_6e2[k]
        print("  6e2: Gemini copy generated.")
    except Exception as e:
        print(f"  [warn] 6e2 Gemini: {e} — using fallbacks.", file=sys.stderr)

    if index_astro_6e2.exists():
        # CTA strip heading
        try:
            ip.sed_replace(index_astro_6e2,
                r'<h2>Need a Plumber\?</h2>',
                f'<h2>{copy_6e2["cta_heading"]}</h2>')
        except Exception as e:
            print(f"  [warn] 6e2 cta_heading: {e}", file=sys.stderr)
        # CTA strip paragraph
        try:
            ip.sed_replace(index_astro_6e2,
                r"Call us today or request a free estimate online\. We're available 24/7\.",
                copy_6e2["cta_paragraph"])
        except Exception as e:
            print(f"  [warn] 6e2 cta_paragraph: {e}", file=sys.stderr)
        # CTA strip secondary button text
        try:
            ip.sed_replace(index_astro_6e2,
                r'>Request an Estimate</a>',
                f'>{copy_6e2["cta_button"]}</a>')
        except Exception as e:
            print(f"  [warn] 6e2 cta_button: {e}", file=sys.stderr)
        # Services section subtitle
        try:
            ip.sed_replace(index_astro_6e2,
                r'We handle it all \u2014 from routine maintenance to full emergencies\.',
                copy_6e2["services_subtitle"])
        except Exception as e:
            print(f"  [warn] 6e2 services_subtitle: {e}", file=sys.stderr)
        # Why Choose heading — replace everything after "Why Choose " through end of tag text
        try:
            ip.sed_replace(index_astro_6e2,
                r'Why Choose [^<]+',
                f'Why Choose {biz_name}')
        except Exception as e:
            print(f"  [warn] 6e2 why_choose_heading: {e}", file=sys.stderr)
        # Why Choose subtitle
        try:
            ip.sed_replace(index_astro_6e2,
                r"We've built our reputation one satisfied customer at a time\.",
                copy_6e2["why_choose_subtitle"])
        except Exception as e:
            print(f"  [warn] 6e2 why_choose_subtitle: {e}", file=sys.stderr)
        # features array
        features_js_6e2 = json.dumps(copy_6e2["features"], indent=2)
        try:
            ip.sed_replace(index_astro_6e2,
                r'const features\s*=\s*\[[\s\S]*?\];',
                f'const features = {features_js_6e2};')
        except Exception as e:
            print(f"  [warn] 6e2 features: {e}", file=sys.stderr)

    # Hero.astro default CTA label
    if hero_astro_6e2.exists():
        try:
            ip.sed_replace(hero_astro_6e2,
                r"ctaLabel\s*=\s*'Get a Free Estimate'",
                "ctaLabel = 'Contact Us'")
        except Exception as e:
            print(f"  [warn] 6e2 Hero.astro CTA: {e}", file=sys.stderr)

    # 6f: Images
    img_dir = repo_path / "public" / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    logo_local = manifest.get("logo_local")
    logo_dest  = None

    if logo_local and Path(logo_local).exists():
        ext = Path(logo_local).suffix
        logo_dest = img_dir / f"logo{ext}"
        import shutil
        shutil.copy2(logo_local, logo_dest)
        print(f"  Logo → {logo_dest.name}")
        if ext == ".svg":
            try:
                ip.run_edit_field(repo_path, data_json, "logo", f"/images/logo{ext}")
            except Exception:
                pass
    else:
        primary_hex = brand.get("primary_hex", "#2d3748")
        logo_dest = img_dir / "logo.svg"
        ip._generate_text_logo(biz_name, primary_hex, logo_dest)
        print("  Text logo generated.")

    # Hero: largest crawled image or nano_banana
    best_img = None
    if manifest.get("images"):
        candidates = [
            img for img in manifest["images"]
            if img.get("local_path") and Path(img["local_path"]).exists()
            and img.get("width", 0) >= 400
        ]
        if candidates:
            candidates.sort(key=lambda x: x.get("width", 0) * x.get("height", 0), reverse=True)
            best_img = candidates[0]["local_path"]

    hero_out = img_dir / "hero.png"
    if best_img:
        import shutil
        shutil.copy2(best_img, hero_out)
        print(f"  Hero from crawled image: {Path(best_img).name}")
    else:
        print("  No suitable crawled image — generating hero with Nano Banana...")
        try:
            primary_hex = brand.get("primary_hex", "#2d3748")
            accent_hex  = brand.get("accent_hex", "#4a90e2")
            prompt = (
                f"Full-width website hero background for '{biz_name}'. "
                f"Brand colors: {primary_hex}, {accent_hex}. "
                f"Professional and clean. 1920x600px, no text, suitable as hero background."
            )
            ip.run_nano_banana(prompt, hero_out, [str(logo_dest)] if logo_dest else None)
            print(f"  Hero generated.")
        except Exception as e:
            print(f"  [warn] hero generation: {e}", file=sys.stderr)

    # Copy other crawled images
    for img in manifest.get("images", [])[:20]:
        lp = img.get("local_path")
        if lp and Path(lp).exists() and lp != best_img:
            try:
                dest_name = Path(lp).name
                import shutil
                shutil.copy2(lp, img_dir / dest_name)
            except Exception:
                pass

    # 6g: Colors in global.css
    css_path = repo_path / "src" / "styles" / "global.css"
    if css_path.exists():
        for css_var, hex_val in [
            ("--color-primary",   brand.get("primary_hex", "")),
            ("--color-accent",    brand.get("accent_hex", "")),
            ("--color-accent-dk", brand.get("accent_dark_hex", "")),
        ]:
            if hex_val and hex_val.startswith("#"):
                try:
                    text     = css_path.read_text()
                    new_text = re.sub(
                        rf'({re.escape(css_var)}:\s*)#[0-9a-fA-F]{{3,8}}',
                        rf'\g<1>{hex_val}',
                        text,
                    )
                    if new_text != text:
                        css_path.write_text(new_text)
                        print(f"  CSS {css_var} → {hex_val}")
                except Exception as e:
                    print(f"  [warn] CSS {css_var}: {e}", file=sys.stderr)

    # 6g2: Component CSS & CtaBand injection
    comp_css_path = repo_path / "src" / "styles" / "components.css"
    try:
        comp_css_path.write_text(COMPONENTS_CSS)
        print("  components.css written.")
    except Exception as e:
        print(f"  [warn] components.css: {e}", file=sys.stderr)

    # Add components.css import to BaseLayout.astro after utilities.css import
    _base_layout_6g2 = repo_path / "src" / "layouts" / "BaseLayout.astro"
    if not _base_layout_6g2.exists():
        _candidates = list((repo_path / "src").rglob("BaseLayout.astro"))
        if _candidates:
            _base_layout_6g2 = _candidates[0]
    if _base_layout_6g2.exists():
        try:
            bl_text = _base_layout_6g2.read_text()
            if "components.css" not in bl_text:
                new_bl = bl_text.replace(
                    "import '@/styles/utilities.css';",
                    "import '@/styles/utilities.css';\nimport '@/styles/components.css';",
                )
                if new_bl != bl_text:
                    _base_layout_6g2.write_text(new_bl)
                    print("  BaseLayout.astro: components.css import added.")
        except Exception as e:
            print(f"  [warn] BaseLayout components import: {e}", file=sys.stderr)

    cta_band_path = repo_path / "src" / "components" / "CtaBand.astro"
    try:
        cta_band_path.write_text(CTABAND_ASTRO)
        print("  CtaBand.astro written.")
    except Exception as e:
        print(f"  [warn] CtaBand.astro: {e}", file=sys.stderr)

    # Patch [slug].astro: add CtaBand import + getEntry for business, render CTA band
    slug_astro = repo_path / "src" / "pages" / "[slug].astro"
    if slug_astro.exists():
        try:
            slug_text = slug_astro.read_text()
            if "CtaBand" not in slug_text:
                # Add import
                slug_text = slug_text.replace(
                    "import { getCollection",
                    "import { getCollection, getEntry",
                ).replace(
                    "import { getCollection, getEntry, getEntry",
                    "import { getCollection, getEntry",
                )
                slug_text = slug_text.replace(
                    "import MapEmbed from '@/components/MapEmbed.astro';",
                    "import MapEmbed from '@/components/MapEmbed.astro';\nimport CtaBand from '@/components/CtaBand.astro';",
                )
                # Add business data fetch before closing ---
                slug_text = slug_text.replace(
                    "const fm = page.data;\n---",
                    "const fm = page.data;\n\nconst business = await getEntry('business', 'data');\nconst biz = business.data;\n---",
                )
                # Insert CTA band after <Content />
                slug_text = slug_text.replace(
                    "  <Content />\n\n  {fm.tallyFormId",
                    "  <Content />\n\n  {fm.showCta !== false && (\n    <CtaBand\n      heading=\"Ready to Take the Next Step?\"\n      text=\"Contact us today to learn about our programs.\"\n      primaryLabel={`Call ${biz.phone}`}\n      primaryHref={`tel:${biz.phone.replace(/\\D/g, '')}`}\n    />\n  )}\n\n  {fm.tallyFormId",
                )
                slug_astro.write_text(slug_text)
                print("  [slug].astro: CtaBand injected.")
        except Exception as e:
            print(f"  [warn] [slug].astro CtaBand: {e}", file=sys.stderr)

    # Add showCta field to config.ts pages schema
    config_ts = repo_path / "src" / "content" / "config.ts"
    if config_ts.exists():
        try:
            cfg_text = config_ts.read_text()
            if "showCta" not in cfg_text:
                new_cfg = cfg_text.replace(
                    "    draft: z.boolean().default(false),",
                    "    draft: z.boolean().default(false),\n    showCta: z.boolean().default(true),",
                )
                if new_cfg != cfg_text:
                    config_ts.write_text(new_cfg)
                    print("  config.ts: showCta field added.")
        except Exception as e:
            print(f"  [warn] config.ts showCta: {e}", file=sys.stderr)

    # Set showCta: false on contact.md
    contact_md = repo_path / "src" / "content" / "pages" / "contact.md"
    if contact_md.exists():
        try:
            ctext = contact_md.read_text()
            if "showCta" not in ctext:
                # Insert before closing --- of frontmatter
                ctext = ctext.replace(
                    "\ndraft: false\n---",
                    "\ndraft: false\nshowCta: false\n---",
                )
                contact_md.write_text(ctext)
                print("  contact.md: showCta: false added.")
        except Exception as e:
            print(f"  [warn] contact.md showCta: {e}", file=sys.stderr)

    # 6h: Fonts in global.css and BaseLayout.astro
    heading_font    = fonts.get("heading_font", FALLBACK_HEADING_FONT)
    body_font       = fonts.get("body_font", FALLBACK_BODY_FONT)
    heading_weights = fonts.get("heading_weights", [400, 600, 700])
    body_weights    = fonts.get("body_weights", [400, 600, 700])

    if css_path.exists():
        try:
            text     = css_path.read_text()
            new_text = re.sub(
                r"(--font-heading:\s*')[^']+'",
                rf"\g<1>{heading_font}'",
                text,
            )
            new_text = re.sub(
                r"(--font-sans:\s*')[^']+'",
                rf"\g<1>{body_font}'",
                new_text,
            )
            if new_text != text:
                css_path.write_text(new_text)
                print(f"  CSS fonts: {heading_font} / {body_font}")
        except Exception as e:
            print(f"  [warn] CSS fonts: {e}", file=sys.stderr)

    # BaseLayout.astro — replace Google Fonts link href
    base_layout = repo_path / "src" / "layouts" / "BaseLayout.astro"
    if not base_layout.exists():
        # Some templates put it at a different path
        candidates = list((repo_path / "src").rglob("BaseLayout.astro"))
        if candidates:
            base_layout = candidates[0]

    if base_layout.exists():
        new_fonts_url = _build_google_fonts_url(
            heading_font, body_font, heading_weights, body_weights
        )
        try:
            text     = base_layout.read_text()
            new_text = re.sub(
                r'https://fonts\.googleapis\.com/css2\?[^"\']+',
                new_fonts_url,
                text,
            )
            if new_text != text:
                base_layout.write_text(new_text)
                print(f"  BaseLayout.astro fonts URL updated.")
        except Exception as e:
            print(f"  [warn] BaseLayout.astro: {e}", file=sys.stderr)

    # 6i: Config files
    try:
        ip.sed_replace(repo_path / "astro.config.mjs",
                       r"site:\s*'[^']*'", f"site: 'https://{slug}.pages.dev'")
    except Exception as e:
        print(f"  [warn] astro.config.mjs: {e}", file=sys.stderr)
    try:
        ip.sed_replace(repo_path / ".gitlab-ci.yml",
                       r"--project-name=\S+", f"--project-name={slug}")
    except Exception as e:
        print(f"  [warn] .gitlab-ci.yml: {e}", file=sys.stderr)
    try:
        ip.run_edit_field(repo_path, "package.json", "name", slug)
    except Exception as e:
        print(f"  [warn] package.json: {e}", file=sys.stderr)

    # 6j: Template placeholder replacement
    phone_raw_j  = contact.get("phone", "")
    phone_fmt_j  = ip._fmt_phone_display(phone_raw_j) if phone_raw_j else ""
    phone_dig_j  = re.sub(r"\D", "", phone_raw_j or "")
    if phone_dig_j.startswith("1") and len(phone_dig_j) == 11:
        phone_dig_j = phone_dig_j[1:]
    city_j, state_abbrev_j = _parse_city_state(manifest)
    state_name_j  = _STATE_ABBREV_TO_NAME.get(state_abbrev_j, "")
    city_state_j  = f"{city_j}, {state_abbrev_j}" if city_j and state_abbrev_j else ""

    replacements_j = [
        ("Joe's Plumbing",   biz_name),
        ("Anytown, NY",      city_state_j or biz_name),
        ("Anytown",          city_j or biz_name),
        ("[County] County",  city_j or biz_name),
        ("New York State",   state_name_j),
        ("New York",         state_name_j),
        ("Need a Plumber?",  f"Contact {biz_name}"),
        ("Request an Estimate", "Contact Us"),
        ("Get a Free Estimate", "Contact Us"),
        ("free estimate",    "consultation"),
    ]
    if phone_fmt_j:
        replacements_j.append(("(555) 123-4567", phone_fmt_j))
    if len(phone_dig_j) == 10:
        replacements_j.append(("5551234567", phone_dig_j))

    replacements_j = [(old, new) for old, new in replacements_j if old and new]
    try:
        ip._replace_template_placeholders(repo_path, replacements_j)
        print(f"  Placeholder replacement done ({len(replacements_j)} rules).")
    except Exception as e:
        print(f"  [warn] placeholder replacement: {e}", file=sys.stderr)

    # 6k: Default email fallback — use info@domain when crawl found nothing
    _EMAIL_PLACEHOLDERS = {"info@joesplumbing.com", "info@example.com", ""}
    data_json_path = repo_path / "src/content/business/data.json"
    try:
        with open(data_json_path) as fh:
            dj = json.load(fh)
        cur_email = dj.get("email", "")
        if cur_email in _EMAIL_PLACEHOLDERS:
            domain = urllib.parse.urlparse(manifest["source_url"]).hostname or ""
            domain = re.sub(r'^www\.', '', domain)
            if domain:
                dj["email"] = f"info@{domain}"
            else:
                dj.pop("email", None)
            with open(data_json_path, "w") as fh:
                json.dump(dj, fh, indent=2)
                fh.write("\n")
            print(f"  Email fallback: {dj.get('email', '(removed)')}")
    except Exception as e:
        print(f"  [warn] email cleanup: {e}", file=sys.stderr)

    manifest["variant"]          = variant
    manifest["stage_completed"]  = 6
    _save_manifest(manifest, debug_dir)
    print(f"  Stage 6 done: {slug} at {repo_path}")
    return manifest


# ── Stage 7: Deploy ───────────────────────────────────────────────────────────

def stage7_deploy(manifest, slug, debug_dir, dry_run=False):
    print("  Stage 7: Deploy...")
    debug_dir = Path(debug_dir)
    repo_path = REPOS_ROOT / slug

    if dry_run:
        print("  [dry-run] skipping GitLab + CF Pages deploy")
        manifest["stage_completed"] = 7
        _save_manifest(manifest, debug_dir)
        return manifest

    gitlab_repo = f"flux-cc/{slug}"
    cf_api_key   = ip.load_cf_api_key()
    gitlab_token = ip.load_gitlab_token()

    # Create GitLab repo
    r = subprocess.run(
        [str(GLAB_PATH), "repo", "create", gitlab_repo, "--internal", "--defaultBranch", "main"],
        capture_output=True, text=True,
        env={**os.environ, "GITLAB_TOKEN": gitlab_token},
    )
    if r.returncode != 0 and "already exists" not in (r.stdout + r.stderr):
        print(f"  [warn] glab repo create: {r.stderr[:200]}", file=sys.stderr)
    else:
        print(f"  GitLab: https://gitlab.com/{gitlab_repo}")

    # Create CF Pages project (idempotent)
    cf_env = {**os.environ, "CLOUDFLARE_API_KEY": cf_api_key, "CLOUDFLARE_EMAIL": CF_EMAIL}
    list_r = subprocess.run(
        ["npx", "wrangler", "pages", "project", "list"],
        capture_output=True, text=True, env=cf_env,
    )
    if slug in list_r.stdout:
        print(f"  CF Pages project exists: {slug}.pages.dev")
    else:
        r = subprocess.run(
            ["npx", "wrangler", "pages", "project", "create",
             slug, "--production-branch", "main"],
            capture_output=True, text=True, env=cf_env,
        )
        if r.returncode != 0:
            print(f"  [warn] CF Pages create: {r.stderr[:200]}", file=sys.stderr)
        else:
            print(f"  CF Pages: https://{slug}.pages.dev")

    # Set CF_API_KEY CI variable
    r = subprocess.run(
        [str(GLAB_PATH), "variable", "set", "CF_API_KEY",
         "--value", cf_api_key, "--repo", gitlab_repo],
        capture_output=True, text=True,
        env={**os.environ, "GITLAB_TOKEN": gitlab_token},
    )
    if r.returncode != 0:
        print(f"  [warn] glab variable set: {r.stderr[:150]}", file=sys.stderr)

    # Push
    try:
        ip._git(["git", "remote", "set-url", "origin",
                  f"git@gitlab.com:{gitlab_repo}.git"], repo_path)
    except Exception:
        ip._git(["git", "remote", "add", "origin",
                  f"git@gitlab.com:{gitlab_repo}.git"], repo_path)

    ip._git(["git", "add", "."], repo_path)
    try:
        ip._git(["git", "commit", "-m", f"migrate: {manifest.get('biz_name_detected', slug)}"], repo_path)
    except Exception:
        pass  # nothing to commit
    ip._git(["git", "push", "-u", "origin", "main", "--force"], repo_path)
    print("  Pushed to GitLab — CF Pages build triggered.")

    # Update registry
    try:
        row_id = ip.find_registry_row_id(slug)
        if row_id:
            ip.update_registry_row(
                row_id,
                status="migrated",
                cf_project=slug,
                preview_url=f"{slug}.pages.dev",
                gitlab_repo=gitlab_repo,
            )
    except Exception as e:
        print(f"  [warn] Registry update: {e}", file=sys.stderr)

    manifest["gitlab_repo"]     = gitlab_repo
    manifest["stage_completed"] = 7
    _save_manifest(manifest, debug_dir)
    return manifest


# ── Stage 8: Notify ───────────────────────────────────────────────────────────

def stage8_notify(manifest, biz_name, slug, debug_dir, dry_run=False):
    print("  Stage 8: Notify...")
    debug_dir = Path(debug_dir)

    source_url  = manifest.get("source_url", "")
    brand       = manifest.get("brand", {})
    fonts       = manifest.get("fonts", {})
    page_map    = manifest.get("page_map", [])
    gitlab_repo = manifest.get("gitlab_repo", f"flux-cc/{slug}")
    gmail_id    = manifest.get("gmail_id", "")

    standard_pages = [p for p in page_map if not p.get("is_extra_page")]
    extra_pages    = [p for p in page_map if p.get("is_extra_page")]

    # Content gaps
    expected_slots = {"home", "about", "services", "contact"}
    found_slots    = {p["slot"] for p in standard_pages}
    missing_slots  = expected_slots - found_slots

    images_count = len(manifest.get("images", []))
    logo_source  = manifest.get("logo_local") or "(none detected)"

    body = (
        f"Migration complete for {biz_name}.\n\n"
        f"Source: {source_url}\n"
        f"GitLab: https://gitlab.com/{gitlab_repo}\n"
        f"Preview: https://{slug}.pages.dev\n\n"
        f"--- Brand Colors ---\n"
        f"Primary:   {brand.get('primary_hex','(none)')}\n"
        f"Accent:    {brand.get('accent_hex','(none)')}\n"
        f"Accent DK: {brand.get('accent_dark_hex','(none)')}\n\n"
        f"--- Font Pairing ---\n"
        f"Heading:   {fonts.get('heading_font','(none)')}\n"
        f"Body:      {fonts.get('body_font','(none)')}\n"
        f"Reasoning: {fonts.get('reasoning','')}\n\n"
        f"--- Pages ({len(page_map)} total) ---\n"
    )
    for p in standard_pages:
        body += f"  [{p['slot']}] {p['source_url']}\n"
    if extra_pages:
        body += f"  Extra pages ({len(extra_pages)}):\n"
        for p in extra_pages[:5]:
            body += f"    {p['source_path']} → {p['slot']}.md\n"

    if missing_slots:
        body += f"\n--- Content Gaps ---\n"
        body += f"Missing standard pages: {', '.join(sorted(missing_slots))}\n"

    body += (
        f"\n--- Assets ---\n"
        f"Images: {images_count} crawled\n"
        f"Logo source: {logo_source}\n"
    )

    if not dry_run:
        try:
            ip.gmail_draft_to_nick(f"[migrate] {biz_name} — migration complete", body)
            print("  Gmail draft created.")
        except Exception as e:
            print(f"  [warn] Gmail draft: {e}", file=sys.stderr)

        # Update inbox status
        if gmail_id:
            try:
                ip.upsert_inbox_row(
                    gmail_id=gmail_id, from_addr="",
                    subject=f"[migrate] {biz_name}", status="migrated",
                    client_hint=slug,
                )
            except Exception as e:
                print(f"  [warn] inbox status update: {e}", file=sys.stderr)
    else:
        print("  [dry-run] notification body:")
        for line in body.splitlines():
            print(f"    {line}")

    manifest["stage_completed"] = 8
    _save_manifest(manifest, debug_dir)
    return manifest


# ── CLI commands ──────────────────────────────────────────────────────────────

import subprocess  # noqa: E402 — needed at module level for stage7


def _resolve_biz_and_slug(args_name, manifest):
    biz_name = args_name or manifest.get("biz_name_detected") or ""
    if not biz_name:
        biz_name = urllib.parse.urlparse(manifest["source_url"]).netloc.replace("www.", "")
    slug = manifest["slug"]
    return biz_name, slug


def cmd_migrate(args):
    source_url = args.url.rstrip("/")
    if not source_url.startswith("http"):
        source_url = "https://" + source_url

    # Determine slug before crawl so we know where to store things
    name_hint = args.name or ""
    if name_hint:
        base_slug = ip.slugify(name_hint)
    else:
        domain = urllib.parse.urlparse(source_url).netloc.replace("www.", "")
        base_slug = ip.slugify(domain.split(".")[0])

    slug = ip.unique_slug(base_slug)
    print(f"\n=== FluxCC Migrate: {source_url} → {slug} ===\n")

    debug_dir = DEBUG_DIR / f"migrate-{slug}"
    debug_dir.mkdir(parents=True, exist_ok=True)

    # Stage 1
    print("[Stage 1] Crawl & Extract")
    manifest = stage1_crawl(slug, source_url, force=args.force_crawl)
    manifest["_debug_dir"] = str(debug_dir)

    biz_name, slug = _resolve_biz_and_slug(args.name, manifest)
    print(f"  Business name: {biz_name}")

    # Stage 2
    print("\n[Stage 2] Brand Analysis")
    manifest = stage2_brand(manifest, debug_dir)

    # Stage 3
    print("\n[Stage 3] Font Pairing")
    manifest = stage3_fonts(manifest, debug_dir)

    # Stage 4
    print("\n[Stage 4] Page Mapping")
    manifest = stage4_page_map(manifest, debug_dir)

    # Stage 5
    print("\n[Stage 5] Tracking Setup")
    manifest = stage5_tracking(manifest, biz_name, slug, debug_dir)

    # Stage 6
    print("\n[Stage 6] Scaffold & Populate")
    manifest = stage6_scaffold(
        manifest, biz_name, slug, debug_dir,
        variant=getattr(args, "variant", None),
        dry_run=args.dry_run,
    )

    # Stage 7
    print("\n[Stage 7] Deploy")
    if args.skip_deploy:
        print("  --skip-deploy set, skipping.")
        manifest["gitlab_repo"] = f"flux-cc/{slug}"
    else:
        manifest = stage7_deploy(manifest, slug, debug_dir, dry_run=args.dry_run)

    # Stage 8
    print("\n[Stage 8] Notify")
    manifest = stage8_notify(manifest, biz_name, slug, debug_dir, dry_run=args.dry_run)

    print(f"\n=== Migration complete: {slug} ===")
    print(f"  Manifest:  {debug_dir}/crawl-manifest.json")
    print(f"  Repo:      {REPOS_ROOT / slug}")
    if not args.skip_deploy:
        print(f"  Preview:   https://{slug}.pages.dev")


def cmd_resume(args):
    slug      = args.slug
    from_stage = args.from_stage

    manifest  = _load_manifest(slug)
    debug_dir = DEBUG_DIR / f"migrate-{slug}"
    manifest["_debug_dir"] = str(debug_dir)

    biz_name = manifest.get("biz_name_detected") or slug
    print(f"\n=== FluxCC Resume: {slug} from stage {from_stage} ===\n")

    STAGES = {
        1: lambda: stage1_crawl(slug, manifest["source_url"], force=True),
        2: lambda: stage2_brand(manifest, debug_dir),
        3: lambda: stage3_fonts(manifest, debug_dir),
        4: lambda: stage4_page_map(manifest, debug_dir),
        5: lambda: stage5_tracking(manifest, biz_name, slug, debug_dir),
        6: lambda: stage6_scaffold(manifest, biz_name, slug, debug_dir),
        7: lambda: stage7_deploy(manifest, slug, debug_dir),
        8: lambda: stage8_notify(manifest, biz_name, slug, debug_dir),
    }

    for stage_num in range(from_stage, 9):
        label = {
            1: "Crawl & Extract", 2: "Brand Analysis", 3: "Font Pairing",
            4: "Page Mapping",    5: "Tracking Setup", 6: "Scaffold & Populate",
            7: "Deploy",          8: "Notify",
        }.get(stage_num, f"Stage {stage_num}")
        print(f"[Stage {stage_num}] {label}")
        fn = STAGES.get(stage_num)
        if fn:
            result = fn()
            if result:
                manifest = result
                manifest["_debug_dir"] = str(debug_dir)

    print(f"\n=== Resume complete: {slug} ===")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="FluxCC Migration Pipeline — migrate a live site to Astro/CF Pages"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # migrate
    p_migrate = sub.add_parser("migrate", help="Start a new migration from a URL")
    p_migrate.add_argument("url", help="Source website URL")
    p_migrate.add_argument("--name",        help="Override detected business name")
    p_migrate.add_argument("--variant",     help="Template variant (fluxcc-business, fluxcc-legal, fluxcc-author)")
    p_migrate.add_argument("--force-crawl", action="store_true", help="Re-crawl even if manifest exists")
    p_migrate.add_argument("--skip-deploy", action="store_true", help="Skip GitLab + CF Pages deploy")
    p_migrate.add_argument("--dry-run",     action="store_true", help="No writes to GitLab/CF/Gmail")

    # resume
    p_resume = sub.add_parser("resume", help="Resume a migration from a specific stage")
    p_resume.add_argument("slug",        help="Project slug")
    p_resume.add_argument("--from-stage", dest="from_stage", type=int, default=2,
                           help="Stage number to resume from (1-8, default 2)")

    args = parser.parse_args()

    if args.command == "migrate":
        cmd_migrate(args)
    elif args.command == "resume":
        cmd_resume(args)


if __name__ == "__main__":
    main()
