#!/usr/bin/env python3
"""Log into BidNet Direct, save session state, and pull solicitation details/docs.

Credentials come from env (BIDNET_EMAIL / BIDNET_PASSWORD) for first login;
afterwards the saved storage state at STATE_PATH is reused so the password
is not needed again until the session expires.

Usage:
  python3 bidnet_pull.py login                 # authenticate + save session state
  python3 bidnet_pull.py page <url> <outdir>   # fetch a solicitation page + list/download docs
"""
import os
import sys
import json
import pathlib

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

STATE_PATH = os.path.expanduser("~/.claude/mcp-credentials/bidnet/state.json")
SHOTS = os.path.expanduser("~/OpenDia/bids/.bidnet-shots")
LOGIN_URL = "https://www.bidnetdirect.com/public/authentication/login"


def shot(page, name):
    pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
    page.screenshot(path=f"{SHOTS}/{name}.png", full_page=False)


def do_login(pw):
    email = os.environ["BIDNET_EMAIL"]
    password = os.environ["BIDNET_PASSWORD"]
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    )
    page = ctx.new_page()
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(2500)
    shot(page, "01-login-page")

    # try common selectors for the login form
    filled = False
    for user_sel, pass_sel in [
        ("input[name='j_username']", "input[name='j_password']"),
        ("input[name='username']", "input[name='password']"),
        ("input[type='email']", "input[type='password']"),
        ("#username", "#password"),
    ]:
        if page.locator(user_sel).count() and page.locator(pass_sel).count():
            page.fill(user_sel, email)
            page.fill(pass_sel, password)
            filled = True
            break
    if not filled:
        print("LOGIN-FORM-NOT-FOUND; page title:", page.title())
        print(page.content()[:3000])
        shot(page, "01b-no-form")
        browser.close()
        sys.exit(2)

    shot(page, "02-filled")
    for btn in ["button[type='submit']", "input[type='submit']",
                "button:has-text('Login')", "button:has-text('Log in')",
                "button:has-text('Sign in')"]:
        if page.locator(btn).count():
            page.locator(btn).first.click()
            break
    try:
        page.wait_for_load_state("networkidle", timeout=30000)
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


def do_page(pw, url, outdir):
    outp = pathlib.Path(os.path.expanduser(outdir))
    outp.mkdir(parents=True, exist_ok=True)
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(storage_state=STATE_PATH, accept_downloads=True)
    page = ctx.new_page()
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(3500)
    shot(page, "10-solicitation")
    # dump visible text for analysis
    text = page.evaluate("document.body.innerText")
    (outp / "page-text.txt").write_text(text)
    print("PAGE TEXT SAVED:", outp / "page-text.txt", f"({len(text)} chars)")

    # collect candidate document links
    links = page.evaluate(
        """Array.from(document.querySelectorAll('a')).map(a => ({href: a.href, text: (a.innerText||'').trim()}))
           .filter(l => l.text && (l.href.includes('document') || l.href.includes('download') || l.href.includes('attachment') || /\\.(pdf|docx?|xlsx?|zip)(\\?|$)/i.test(l.href)))"""
    )
    print("DOC LINK CANDIDATES:")
    for l in links:
        print(" -", l["text"][:80], "=>", l["href"])
    (outp / "doc-links.json").write_text(json.dumps(links, indent=2))

    # attempt download buttons/links
    for l in links:
        try:
            with page.expect_download(timeout=15000) as dl_info:
                page.goto(l["href"])
            dl = dl_info.value
            dest = outp / dl.suggested_filename
            dl.save_as(dest)
            print("DOWNLOADED:", dest)
        except Exception as e:
            print("no direct download for:", l["href"][:100], "|", str(e)[:80])
    browser.close()


def do_search(pw, keyword, outdir):
    """Navigate the private search UI like a user and open the first matching solicitation."""
    outp = pathlib.Path(os.path.expanduser(outdir))
    outp.mkdir(parents=True, exist_ok=True)
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(
        storage_state=STATE_PATH,
        accept_downloads=True,
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    )
    page = ctx.new_page()
    page.goto("https://www.bidnetdirect.com/private/supplier/solicitations/search",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(3000)

    # dismiss cookie banner if present
    for sel in ["button:has-text('Allow all cookies')", "button:has-text('Accept')"]:
        if page.locator(sel).count():
            page.locator(sel).first.click()
            page.wait_for_timeout(800)
            break
    shot(page, "20-search-page")

    # find the keyword box (visible one is textarea#solicitationSingleBoxSearch)
    box = None
    for sel in ["textarea#solicitationSingleBoxSearch", "textarea[placeholder*='keyword' i]",
                "input[placeholder*='keyword' i]", "input[type='search']"]:
        if page.locator(sel).count():
            box = sel
            break
    if not box:
        print("SEARCH-BOX-NOT-FOUND")
        print(page.evaluate("document.body.innerText")[:2000])
        browser.close()
        sys.exit(2)
    page.fill(box, keyword)
    page.keyboard.press("Enter")
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PWTimeout:
        pass
    page.wait_for_timeout(3000)
    shot(page, "21-results")
    print("RESULTS URL:", page.url)
    text = page.evaluate("document.body.innerText")
    (outp / "search-results.txt").write_text(text)

    # click first solicitation result link
    link = None
    for sel in ["a[href*='/solicitations/']", "td a", "h3 a", "a.solicitation-link"]:
        loc = page.locator(sel)
        for i in range(min(loc.count(), 10)):
            href = loc.nth(i).get_attribute("href") or ""
            t = (loc.nth(i).inner_text() or "").strip()
            if "/solicitations/" in href and len(t) > 10:
                link = loc.nth(i)
                print("CLICKING:", t[:80], "=>", href)
                break
        if link:
            break
    if not link:
        print("NO-RESULT-LINK; results text follows:")
        print(text[:3000])
        browser.close()
        sys.exit(3)
    link.click()
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PWTimeout:
        pass
    page.wait_for_timeout(3000)
    shot(page, "22-detail")
    print("DETAIL URL:", page.url)
    dtext = page.evaluate("document.body.innerText")
    (outp / "page-text.txt").write_text(dtext)
    print("PAGE TEXT SAVED:", outp / "page-text.txt", f"({len(dtext)} chars)")

    links = page.evaluate(
        """Array.from(document.querySelectorAll('a')).map(a => ({href: a.href, text: (a.innerText||'').trim()}))
           .filter(l => l.text && (l.href.includes('document') || l.href.includes('download') || l.href.includes('attachment') || /\\.(pdf|docx?|xlsx?|zip)(\\?|$)/i.test(l.href)))"""
    )
    print("DOC LINK CANDIDATES:")
    for l in links:
        print(" -", l["text"][:80], "=>", l["href"])
    (outp / "doc-links.json").write_text(json.dumps(links, indent=2))

    for l in links:
        try:
            with page.expect_download(timeout=15000) as dl_info:
                page.evaluate("href => { const a=document.createElement('a'); a.href=href; document.body.appendChild(a); a.click(); }", l["href"])
            dl = dl_info.value
            dest = outp / dl.suggested_filename
            dl.save_as(dest)
            print("DOWNLOADED:", dest)
        except Exception as e:
            print("no download via:", l["href"][:100], "|", str(e)[:80])
    browser.close()


if __name__ == "__main__":
    cmd = sys.argv[1]
    with sync_playwright() as pw:
        if cmd == "login":
            do_login(pw)
        elif cmd == "page":
            do_page(pw, sys.argv[2], sys.argv[3])
        elif cmd == "search":
            do_search(pw, sys.argv[2], sys.argv[3])
