#!/usr/bin/env python3
"""Log into NYS Contract Reporter and pull full ad details.

Credentials from env (NYSCR_EMAIL / NYSCR_PASSWORD) for login; session state
persisted to STATE_PATH for reuse until it expires.

Usage:
  python3 nyscr_pull.py login
  python3 nyscr_pull.py ad <search-term> <outdir>
"""
import os
import sys
import json
import pathlib

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

STATE_PATH = os.path.expanduser("~/.claude/mcp-credentials/nyscr/state.json")
SHOTS = os.path.expanduser("~/OpenDia/bids/.nyscr-shots")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def shot(page, name):
    pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=f"{SHOTS}/{name}.png")
    except Exception:
        pass


def do_login(pw):
    email = os.environ["NYSCR_EMAIL"]
    password = os.environ["NYSCR_PASSWORD"]
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(user_agent=UA)
    page = ctx.new_page()
    page.goto("https://www.nyscr.ny.gov/Account/Login", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(2500)
    shot(page, "01-login")
    filled = False
    for user_sel, pass_sel in [
        ("input[name='Email']", "input[name='Password']"),
        ("input[type='email']", "input[type='password']"),
        ("#Email", "#Password"),
        ("input[name='username']", "input[name='password']"),
    ]:
        if page.locator(user_sel).count() and page.locator(pass_sel).count():
            page.fill(user_sel, email)
            page.fill(pass_sel, password)
            filled = True
            break
    if not filled:
        print("LOGIN-FORM-NOT-FOUND at", page.url)
        print(page.evaluate("document.body.innerText")[:1500])
        browser.close()
        sys.exit(2)
    shot(page, "02-filled")
    for btn in ["button[type='submit']", "input[type='submit']",
                "button:has-text('Log in')", "button:has-text('Login')", "button:has-text('Sign in')"]:
        if page.locator(btn).count():
            page.locator(btn).first.click()
            break
    try:
        page.wait_for_load_state("networkidle", timeout=25000)
    except PWTimeout:
        pass
    page.wait_for_timeout(3000)
    shot(page, "03-after-login")
    print("POST-LOGIN URL:", page.url)
    print("POST-LOGIN TITLE:", page.title())
    pathlib.Path(os.path.dirname(STATE_PATH)).mkdir(parents=True, exist_ok=True)
    ctx.storage_state(path=STATE_PATH)
    os.chmod(STATE_PATH, 0o600)
    print("STATE SAVED:", STATE_PATH)
    browser.close()


def do_ad(pw, term, outdir):
    outp = pathlib.Path(os.path.expanduser(outdir))
    outp.mkdir(parents=True, exist_ok=True)
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(storage_state=STATE_PATH, accept_downloads=True, user_agent=UA)
    page = ctx.new_page()
    page.goto(f"https://www.nyscr.ny.gov/Ads/Search?keyword={term}", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(3000)
    shot(page, "10-search")
    # click the first ad result link
    clicked = False
    for sel in ["a[href*='/ads/']", "a[href*='ViewAd']", "a[href*='AdDetail']", "h3 a", "td a"]:
        loc = page.locator(sel)
        for i in range(min(loc.count(), 15)):
            href = (loc.nth(i).get_attribute("href") or "").lower()
            t = (loc.nth(i).inner_text() or "").strip()
            if len(t) > 8 and ("ad" in href) and "search" not in href:
                print("CLICKING:", t[:70], "=>", href)
                loc.nth(i).click()
                clicked = True
                break
        if clicked:
            break
    if not clicked:
        print("NO-AD-LINK; page text:")
        print(page.evaluate("document.body.innerText")[:2500])
        browser.close()
        sys.exit(3)
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PWTimeout:
        pass
    page.wait_for_timeout(3000)
    shot(page, "11-ad-detail")
    print("AD URL:", page.url)
    text = page.evaluate("document.body.innerText")
    (outp / "ad-text.txt").write_text(text)
    print("AD TEXT SAVED:", outp / "ad-text.txt", f"({len(text)} chars)")
    links = page.evaluate(
        """Array.from(document.querySelectorAll('a')).map(a => ({href: a.href, text: (a.innerText||'').trim()}))
           .filter(l => l.text && /\\.(pdf|docx?|xlsx?|zip)(\\?|$)/i.test(l.href) || /download|attachment|document/i.test(l.href))"""
    )
    for l in links:
        print("DOC:", l["text"][:70], "=>", l["href"][:140])
    (outp / "doc-links.json").write_text(json.dumps(links, indent=2))
    for l in links:
        try:
            with page.expect_download(timeout=15000) as dl:
                page.evaluate("h => { const a=document.createElement('a'); a.href=h; document.body.appendChild(a); a.click(); }", l["href"])
            d = dl.value
            d.save_as(outp / d.suggested_filename)
            print("DOWNLOADED:", d.suggested_filename)
        except Exception as e:
            print("no download:", l["href"][:90], "|", str(e)[:60])
    browser.close()


if __name__ == "__main__":
    cmd = sys.argv[1]
    with sync_playwright() as pw:
        if cmd == "login":
            do_login(pw)
        elif cmd == "ad":
            do_ad(pw, sys.argv[2], sys.argv[3])
