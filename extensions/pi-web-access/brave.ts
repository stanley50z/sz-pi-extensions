import { activityMonitor } from "./activity.js";
import { getEnvApiKey } from "./config.js";
import type { SearchOptions, SearchResponse } from "./search-types.js";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

interface BraveWebSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function recencyToFreshness(filter: SearchOptions["recencyFilter"]): string | undefined {
  if (!filter) return undefined;
  return ({ day: "pd", week: "pw", month: "pm", year: "py" } as const)[filter];
}

function applyDomainFilter(query: string, domains: string[] | undefined): string {
  if (!domains?.length) return query;
  const parts = [query];
  for (const domain of domains) {
    const trimmed = domain.trim();
    if (!trimmed) continue;
    parts.push(trimmed.startsWith("-") ? `-site:${trimmed.slice(1)}` : `site:${trimmed}`);
  }
  return parts.join(" ");
}

export function isBraveAvailable(): boolean {
  return !!getEnvApiKey("BRAVE_API_KEY");
}

export async function searchWithBrave(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const apiKey = getEnvApiKey("BRAVE_API_KEY");
  if (!apiKey) {
    throw new Error("Brave Search API key not found. Set BRAVE_API_KEY in your environment or .env file.");
  }

  const searchQuery = applyDomainFilter(query, options.domainFilter);
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("count", String(Math.min(options.numResults ?? 5, 20)));
  const freshness = recencyToFreshness(options.recencyFilter);
  if (freshness) url.searchParams.set("freshness", freshness);

  const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: requestSignal(options.signal),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Brave Search API error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = await response.json() as BraveWebSearchResponse;
    activityMonitor.logComplete(activityId, response.status);

    const results = (data.web?.results ?? []).map((item, index) => ({
      title: item.title || `Source ${index + 1}`,
      url: item.url || "",
      snippet: item.description || "",
    })).filter(item => item.url.length > 0);

    const answer = results
      .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}\nSource: ${result.url}`.trim())
      .join("\n\n");

    return { answer, results };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("abort")) {
      activityMonitor.logComplete(activityId, 0);
    } else {
      activityMonitor.logError(activityId, message);
    }
    throw err;
  }
}
