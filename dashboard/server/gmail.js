import { readFileSync } from "fs";
import { resolve } from "path";

const CREDENTIALS_PATH = resolve(
  process.env.HOME,
  ".claude",
  "mcp-credentials",
  "google-workspace.json"
);
const TOKENS_PATH = resolve(
  process.env.HOME,
  ".claude",
  "mcp-credentials",
  "google-workspace",
  "tokens.json"
);

function loadCredentials() {
  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
  return { creds: creds.installed, tokens };
}

async function refreshAccessToken(creds, tokens) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  // expires_in is seconds from Google (typically 3599); fall back to a
  // conservative 55 minutes if it's ever absent.
  const ttlMs = (data.expires_in || 3300) * 1000;
  return { accessToken: data.access_token, expiresAt: Date.now() + ttlMs };
}

// Request-lifetime memo, NOT persisted to tokens.json — that file is shared
// with the MCP server and the inbox cron, and a re-consent from either side
// REPLACES its scopes wholesale (see reference_google_oauth_scopes). Without
// this memo, a paging loop (listInboxThreadsPage walking hundreds of thread
// ids) that crosses the on-disk expiry boundary would re-refresh on every
// single gmailFetch call, since the disk file never records the refresh.
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt - 60000) {
    return cachedToken.accessToken;
  }
  const { creds, tokens } = loadCredentials();
  if (tokens.expiry_date && now < tokens.expiry_date - 60000) {
    cachedToken = { accessToken: tokens.access_token, expiresAt: tokens.expiry_date };
    return cachedToken.accessToken;
  }
  cachedToken = await refreshAccessToken(creds, tokens);
  return cachedToken.accessToken;
}

async function gmailFetch(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// Like gmailFetch, but the caller gets to tell a 404 from a 401/429 instead
// of "null" for everything — gmailFetch's callers were all written to treat
// null uniformly, so this is a separate helper rather than a behavior change
// to the existing exports.
async function gmailFetchStatus(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  return { ok: true, status: res.status, data: await res.json() };
}

/**
 * Fetch message metadata for a list of message objects from the search API.
 * Returns enriched email objects.
 */
async function fetchMessageDetails(messages) {
  const emails = [];
  for (const msg of messages) {
    const full = await gmailFetch(`/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    if (!full) continue;

    const headers = full.payload?.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
    const from = headers.find((h) => h.name === "From")?.value || "";
    const date = headers.find((h) => h.name === "Date")?.value || "";

    emails.push({
      id: msg.id,
      threadId: msg.threadId,
      subject,
      from,
      date,
      snippet: full.snippet || "",
      threadUrl: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
    });
  }
  return emails;
}

/**
 * List the top N threads from the primary inbox category.
 * Returns one entry per conversation (most recent reply), ordered by latest activity.
 */
export async function listPrimaryInboxTop(n = 5) {
  const query = "in:inbox category:primary";
  const result = await gmailFetch(
    `/threads?q=${encodeURIComponent(query)}&maxResults=${n}`
  );
  if (!result?.threads) return [];

  const out = [];
  for (const t of result.threads.slice(0, n)) {
    const full = await gmailFetch(
      `/threads/${t.id}?format=metadata` +
      `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
    );
    if (!full?.messages?.length) continue;
    const lastMsg = full.messages[full.messages.length - 1];
    const headers = lastMsg.payload?.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
    const from = headers.find((h) => h.name === "From")?.value || "";
    const date = headers.find((h) => h.name === "Date")?.value || "";
    out.push({
      id: lastMsg.id,
      threadId: t.id,
      subject,
      from,
      date,
      snippet: full.snippet || lastMsg.snippet || "",
      threadUrl: `https://mail.google.com/mail/u/0/#inbox/${t.id}`,
    });
  }
  return out;
}

/**
 * Search Gmail for recent emails related to a company.
 * Runs multiple queries (company name, short name, sender domain) and deduplicates.
 * Returns an array of { subject, from, date, snippet, threadUrl }.
 */
export async function searchRecentEmails(companyName, { shortName, days = 7 } = {}) {
  if (!companyName || companyName === "Linnflux") return [];

  // Restrict to inbox or the ~Linnflux Cloud Solutions label (Label_2)
  // Gmail OR syntax: {query1 query2} means either condition
  const SCOPE = "{in:inbox label:~linnflux-cloud-solutions}";

  // Exclude automated service senders that mention client names in digests
  const EXCLUDE = [
    "toggl.com", "notion.so", "github.com", "gitlab.com", "cloudflare.com",
    "google.com", "googleapis.com", "aws.amazon.com", "anthropic.com",
    "make.com", "integromat.com", "stripe.com", "squareup.com",
  ].map((d) => `-from:${d}`).join(" ");

  // Build multiple search queries to cast a wider net
  const queries = [`"${companyName}" ${SCOPE} ${EXCLUDE} newer_than:${days}d`];

  // Search by short name if it's specific enough (5+ chars avoids generic matches)
  if (shortName && shortName.length >= 5 && shortName.toLowerCase() !== companyName.toLowerCase()) {
    queries.push(`"${shortName}" ${SCOPE} ${EXCLUDE} newer_than:${days}d`);
  }

  // Try to derive sender domain patterns from company name
  // Strip common suffixes and build partial domain matches
  const STRIP_WORDS = new Set(["team", "inc", "llc", "corp", "co", "ltd", "group", "services", "company"]);
  const words = companyName
    .replace(/[^a-zA-Z\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STRIP_WORDS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());

  if (words.length > 0) {
    // Full concatenation: "PA Animal Response" -> "paanimalresponse"
    const domainBase = words.join("");
    if (domainBase.length > 4) {
      // Use partial from: match — Gmail matches substrings in the from field
      queries.push(`from:${domainBase} ${SCOPE} ${EXCLUDE} newer_than:${days}d`);
    }
  }

  // Run all searches in parallel, collect unique message IDs
  const allMessages = new Map();
  const results = await Promise.all(
    queries.map((q) =>
      gmailFetch(`/messages?q=${encodeURIComponent(q)}&maxResults=10`)
        .catch(() => null)
    )
  );
  for (const res of results) {
    if (res?.messages) {
      for (const msg of res.messages) {
        if (!allMessages.has(msg.id)) {
          allMessages.set(msg.id, msg);
        }
      }
    }
  }

  if (allMessages.size === 0) return [];

  // Fetch details for all unique messages
  const emails = await fetchMessageDetails(Array.from(allMessages.values()));

  // Deduplicate by threadId (keep most recent per thread)
  const seen = new Map();
  for (const e of emails) {
    if (!seen.has(e.threadId)) {
      seen.set(e.threadId, e);
    }
  }

  return Array.from(seen.values());
}

// ── Mailroom: inbox browse + full thread bodies ─────────────────────────────
// Ordered-thread-id cache: threads.list has no sort parameter and returns
// newest-first, so serving "oldest N, offset M" means walking every page to
// exhaustion once, reversing, then slicing — expensive to redo per request. A
// short TTL keeps a "Show more" paging session stable (the ordering can't
// shift under the operator mid-browse) without re-walking the mailbox on
// every request; the tradeoff is a moved/archived/newly-labeled thread
// staying (or missing) in the list for up to the TTL.
const THREAD_LIST_TTL_MS = 30_000;
let threadListCache = null; // { query, ids, at }

async function orderedInboxThreadIds(query) {
  if (threadListCache && threadListCache.query === query &&
      Date.now() - threadListCache.at < THREAD_LIST_TTL_MS) {
    return threadListCache.ids;
  }
  const ids = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ q: query, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const { ok, data } = await gmailFetchStatus(`/threads?${params}`);
    if (!ok) break;
    for (const t of data.threads || []) ids.push(t.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  ids.reverse(); // newest-first from the API -> oldest-first for the nav list
  threadListCache = { query, ids, at: Date.now() };
  return ids;
}

/**
 * Page the primary inbox oldest-first, excluding threads already labeled
 * Mailroom Handled. Gmail's threads.list has no sort or offset parameter, so
 * the full id order is resolved once (cached briefly — see
 * orderedInboxThreadIds) and metadata is fetched only for the requested
 * slice, in parallel since a page is a handful of threads.
 */
export async function listInboxThreadsPage(offset = 0, limit = 5) {
  const query = "in:inbox category:primary -label:mailroom-handled";
  const ids = await orderedInboxThreadIds(query);
  const pageIds = ids.slice(offset, offset + limit);
  const threads = (await Promise.all(pageIds.map(async (id) => {
    const { ok, data } = await gmailFetchStatus(
      `/threads/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
    );
    if (!ok || !data?.messages?.length) return null;
    const lastMsg = data.messages[data.messages.length - 1];
    const headers = lastMsg.payload?.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
    const from = headers.find((h) => h.name === "From")?.value || "";
    const date = headers.find((h) => h.name === "Date")?.value || "";
    return {
      threadId: id,
      subject,
      from,
      date,
      messageCount: data.messages.length,
      snippet: data.snippet || lastMsg.snippet || "",
      threadUrl: `https://mail.google.com/mail/u/0/#inbox/${id}`,
    };
  }))).filter(Boolean);
  return { threads, total: ids.length, hasMore: offset + limit < ids.length };
}

function decodeBase64Url(data) {
  if (!data) return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf-8");
}

// Deliberately basic: this is a last-resort fallback for messages with no
// text/plain part at all, not a general HTML renderer — the payload never
// reaches the client as markup either way (text only, per the mailroom's
// "never inject raw HTML" rule).
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recursive plain-text body extraction, ported from gmail_helper.py's
 * _extract_body (Python) — the MCP server's TS extractBody is hand-unrolled
 * to two MIME levels and returns "" on a three-level tree, so it is not the
 * reference here. Prefers text/plain at every level of the MIME tree; falls
 * back to text/html (stripped, entities decoded) only when no plain sibling
 * exists anywhere. base64url-decoded, not plain base64 (the TS version's bug).
 */
function extractBody(payload) {
  if (!payload) return "";
  const mime = payload.mimeType || "";
  if (mime === "text/plain") {
    return decodeBase64Url(payload.body?.data);
  }
  if (mime === "text/html") {
    const html = decodeBase64Url(payload.body?.data);
    return html ? stripHtml(html) : "";
  }
  const parts = payload.parts || [];
  // Try every text/plain sibling before falling through to HTML — a real
  // multipart/alternative in the wild had a text/plain part with a genuinely
  // empty body (bodySize 0) next to a populated text/html part; taking
  // plainParts[0] unconditionally (the Python original's behavior) silently
  // returns "" for a message that has readable content one part over.
  const plainParts = parts.filter((p) => p.mimeType === "text/plain");
  for (const p of plainParts) {
    const result = extractBody(p);
    if (result.trim()) return result;
  }
  for (const part of parts) {
    const result = extractBody(part);
    if (result.trim()) return result;
  }
  return "";
}

// Recursively collect parts that carry a filename and an attachmentId.
// Ported from gmail_helper.py's _collect_attachments.
function collectAttachments(payload, out) {
  if (!payload) return;
  const filename = payload.filename;
  const body = payload.body || {};
  if (filename && body.attachmentId) {
    out.push({
      filename,
      mimeType: payload.mimeType || "application/octet-stream",
      size: body.size || 0,
    });
  }
  for (const part of payload.parts || []) collectAttachments(part, out);
}

/**
 * The full thread for the Mailroom main pane: every message, sanitized text
 * bodies only (never raw HTML — the client renders text, full stop),
 * attachment metadata, sorted oldest-first by internalDate (Gmail's own
 * thread order is not guaranteed, per gmail_helper.py's get_thread_messages).
 * Returns null on any fetch failure (no such thread, auth broken, etc.) —
 * the caller distinguishes those cases itself via gmailFetchStatus if needed.
 */
export async function getThreadFull(threadId) {
  const { ok, status, data } = await gmailFetchStatus(`/threads/${threadId}?format=full`);
  if (!ok) return { ok: false, status };
  const messages = (data.messages || [])
    .slice()
    .sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0))
    .map((m) => {
      const headers = m.payload?.headers || [];
      const h = (name) => headers.find((x) => x.name.toLowerCase() === name)?.value || "";
      const attachments = [];
      collectAttachments(m.payload, attachments);
      return {
        id: m.id,
        from: h("from"),
        to: h("to"),
        date: h("date"),
        subject: h("subject"),
        body: extractBody(m.payload),
        attachments,
      };
    });
  return { ok: true, status, threadId, messages };
}
