import { config } from "dotenv";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

// Deployment-specific resource IDs live in ~/OpenDia/.opendia.conf, the same
// file scripts/opendia_config.py reads. They are kept out of this repo because
// it is public: sheet and database IDs are not secrets, but they are durable
// pointers at live business data. One config file, two readers.
function loadConf() {
  try {
    const text = readFileSync(
      resolve(process.env.HOME, "OpenDia", ".opendia.conf"),
      "utf8",
    );
    return Object.fromEntries(
      text
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

const CONF = loadConf();

/** Resolve a deployment-specific value: environment wins, then the conf file. */
export const confValue = (key, fallback = null) =>
  process.env[key] || CONF[key] || fallback;

export const PORT = parseInt(process.env.PORT || "8038", 10);
export const DB_PATH =
  process.env.DB_PATH ||
  resolve(process.env.HOME, "OpenDia", "opendia.db");
export const BILLING_MASTER_SHEET_ID = confValue("BILLING_MASTER_SHEET_ID");
