#!/usr/bin/env python3
"""
inbox_setup_auth.py — One-time setup: add gmail.modify scope to the OAuth token.

The inbox pipeline needs gmail.modify to add/remove labels on messages
(users.messages.modify API endpoint). The existing token was authorized without
this scope. Run this script once to re-authorize.

Usage:
    python3 ~/OpenDia/scripts/inbox_setup_auth.py

This will open a browser authorization URL. Paste the code when prompted.
Your existing token file will be updated in-place (backed up first).
"""

import json
import shutil
from pathlib import Path

CREDENTIALS_PATH = Path.home() / ".claude" / "mcp-credentials" / "google-workspace.json"
TOKENS_PATH = Path.home() / ".claude" / "mcp-credentials" / "google-workspace" / "tokens.json"

# Current token scopes + gmail.modify added
NEW_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.labels",
    "https://www.googleapis.com/auth/gmail.modify",   # ← new: needed for messages.modify
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
]


def main():
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds_data = json.loads(CREDENTIALS_PATH.read_text())

    print("=" * 60)
    print("OpenDia Inbox — OAuth Scope Upgrade")
    print("=" * 60)
    print()
    print("Adding gmail.modify scope to your Google OAuth token.")
    print("This allows the inbox pipeline to add/remove labels on messages.")
    print()
    print("A browser URL will be printed. Open it, authorize, then paste")
    print("the authorization code here.")
    print()

    # Backup existing token
    backup = TOKENS_PATH.with_suffix(".json.pre-inbox")
    shutil.copy2(TOKENS_PATH, backup)
    print(f"Token backed up to: {backup}")
    print()

    # Build flow from credentials file
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), scopes=NEW_SCOPES)

    PORT = 8085

    print(f"This script is running on a headless server.")
    print(f"Before opening the URL below, open a NEW terminal on your LOCAL machine and run:")
    print()
    print(f"    ssh -L {PORT}:localhost:{PORT} opendia")
    print()
    print(f"Leave that tunnel open, then open this URL in your browser:")
    print()

    # Generate the URL manually so we can print it before starting the server
    flow.redirect_uri = f"http://localhost:{PORT}/"
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        include_granted_scopes="false",
    )
    print(auth_url)
    print()
    print(f"After authorizing, the browser will redirect to localhost:{PORT} and show a success page.")
    print(f"Waiting for redirect... (Ctrl+C to cancel)")
    print()

    # Start the local server on the known port — waits for the redirect
    from wsgiref.simple_server import make_server
    import urllib.parse, threading

    auth_code = [None]
    server_error = [None]

    def wsgi_app(environ, start_response):
        qs = urllib.parse.parse_qs(environ.get("QUERY_STRING", ""))
        if "code" in qs:
            auth_code[0] = qs["code"][0]
            start_response("200 OK", [("Content-Type", "text/html")])
            return [b"<h2>Authorization complete. You can close this tab.</h2>"]
        elif "error" in qs:
            server_error[0] = qs.get("error", ["unknown"])[0]
            start_response("200 OK", [("Content-Type", "text/html")])
            return [b"<h2>Authorization failed. Check the terminal.</h2>"]
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [b"Waiting..."]

    httpd = make_server("localhost", PORT, wsgi_app)
    httpd.timeout = 1

    while auth_code[0] is None and server_error[0] is None:
        httpd.handle_request()

    httpd.server_close()

    if server_error[0]:
        raise RuntimeError(f"OAuth error: {server_error[0]}")

    flow.fetch_token(code=auth_code[0])
    creds = flow.credentials

    # Merge into existing token format
    tokens_data = json.loads(TOKENS_PATH.read_text())
    tokens_data["access_token"] = creds.token
    tokens_data["refresh_token"] = creds.refresh_token or tokens_data.get("refresh_token")
    tokens_data["scope"] = " ".join(NEW_SCOPES)
    tokens_data["token_type"] = "Bearer"
    if creds.expiry:
        import calendar as cal
        tokens_data["expiry_date"] = int(cal.timegm(creds.expiry.timetuple()) * 1000)

    TOKENS_PATH.write_text(json.dumps(tokens_data, indent=2))
    print()
    print("Token updated successfully.")
    print("The inbox pipeline can now modify message labels.")

    # Quick verification
    from googleapiclient.discovery import build
    svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    labels = svc.users().labels().list(userId="me").execute()
    print(f"Verification: found {len(labels.get('labels', []))} Gmail labels. Auth working.")


if __name__ == "__main__":
    main()
