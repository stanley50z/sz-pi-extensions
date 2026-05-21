import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasExaApiKey, isExaAvailable, searchWithExa } from "./exa.js";
import { isBraveAvailable, searchWithBrave } from "./brave.js";
import { normalizeSearchProvider, type ResolvedSearchProvider, type SearchProvider } from "./config.js";
import type { SearchOptions, SearchResponse } from "./search-types.js";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

export type { SearchProvider, ResolvedSearchProvider } from "./config.js";

export interface AttributedSearchResponse extends SearchResponse {
  provider: ResolvedSearchProvider;
}

export interface FullSearchOptions extends SearchOptions {
  provider?: SearchProvider;
  includeContent?: boolean;
}

let cachedSearchConfig: { searchProvider: SearchProvider } | null = null;

function getSearchConfig(): { searchProvider: SearchProvider } {
  if (cachedSearchConfig) return cachedSearchConfig;
  if (!existsSync(CONFIG_PATH)) {
    cachedSearchConfig = { searchProvider: "auto" };
    return cachedSearchConfig;
  }
  const rawText = readFileSync(CONFIG_PATH, "utf-8");
  try {
    const raw = JSON.parse(rawText) as { searchProvider?: unknown; provider?: unknown };
    cachedSearchConfig = { searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider) };
    return cachedSearchConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes("abort");
}

export function isProviderAvailable(provider: ResolvedSearchProvider): boolean {
  if (provider === "exa") return isExaAvailable();
  return isBraveAvailable();
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
  const config = getSearchConfig();
  const provider = options.provider ?? config.searchProvider;

  if (provider === "brave") {
    const result = await searchWithBrave(query, options);
    return { ...result, provider: "brave" };
  }

  if (provider === "exa") {
    const exaApiKeyConfigured = hasExaApiKey();
    try {
      const result = await searchWithExa(query, options);
      if (result && "exhausted" in result) {
        throw new Error(
          "Exa monthly free tier exhausted (1,000 requests). Resets next month. Use provider: 'brave' or upgrade at exa.ai/pricing"
        );
      }
      if (result && "answer" in result) return { ...result, provider: "exa" };
      if (exaApiKeyConfigured) throw new Error("Exa search returned no results.");
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (exaApiKeyConfigured) throw err;
    }
    throw new Error("Exa search unavailable. Set EXA_API_KEY in your environment or .env file, or use provider: 'brave'.");
  }

  const fallbackErrors: string[] = [];

  if (isExaAvailable()) {
    try {
      const result = await searchWithExa(query, options);
      if (result && "answer" in result) return { ...result, provider: "exa" };
    } catch (err) {
      if (isAbortError(err)) throw err;
      fallbackErrors.push(`Exa: ${errorMessage(err)}`);
    }
  }

  if (isBraveAvailable()) {
    try {
      const result = await searchWithBrave(query, options);
      return { ...result, provider: "brave" };
    } catch (err) {
      if (isAbortError(err)) throw err;
      fallbackErrors.push(`Brave: ${errorMessage(err)}`);
    }
  }

  if (fallbackErrors.length > 0) {
    throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
  }

  throw new Error(
    "No search provider available. Exa MCP should work without a key; for API-backed search set EXA_API_KEY or BRAVE_API_KEY in your environment or .env file."
  );
}
