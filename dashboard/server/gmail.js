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
  return data.access_token;
}

async function getAccessToken() {
  const { creds, tokens } = loadCredentials();
  // If token is still valid (with 60s buffer), use it
  if (tokens.expiry_date && Date.now() < tokens.expiry_date - 60000) {
    return tokens.access_token;
  }
  return refreshAccessToken(creds, tokens);
}

async function gmailFetch(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
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
