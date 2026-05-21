import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export type SearchProvider = "auto" | "exa" | "brave";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

let dotenvCache: Record<string, string> | null = null;
let dotenvCwd: string | null = null;

function parseDotenv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function findDotenv(start: string): string | null {
  let current = start;
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) return candidate;
    if (current === root) return null;
    current = dirname(current);
  }
}

function loadDotenv(): Record<string, string> {
  const cwd = process.cwd();
  if (dotenvCache && dotenvCwd === cwd) return dotenvCache;
  dotenvCwd = cwd;
  const path = findDotenv(cwd);
  if (!path) {
    dotenvCache = {};
    return dotenvCache;
  }
  dotenvCache = parseDotenv(readFileSync(path, "utf-8"));
  return dotenvCache;
}

function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function getEnvApiKey(name: "EXA_API_KEY" | "BRAVE_API_KEY"): string | null {
  return normalizeApiKey(process.env[name]) ?? normalizeApiKey(loadDotenv()[name]);
}

export function normalizeSearchProvider(value: unknown): SearchProvider {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "auto" || normalized === "exa" || normalized === "brave" ? normalized : "auto";
}
