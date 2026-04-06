import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

export const PORT = parseInt(process.env.PORT || "8038", 10);
export const DB_PATH =
  process.env.DB_PATH ||
  resolve(process.env.HOME, "OpenDia", "opendia.db");
