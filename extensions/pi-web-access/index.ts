import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fetchAllContent, type ExtractedContent } from "./extract.js";
import { clearCloneCache } from "./github-extract.js";
import { search, type SearchProvider } from "./search.js";
import { executeCodeSearch } from "./code-search.js";
import type { SearchResult } from "./search-types.js";
import {
  clearResults,
  deleteResult,
  generateId,
  getAllResults,
  getResult,
  restoreFromSession,
  storeResult,
  type QueryResultData,
  type StoredSearchData,
} from "./storage.js";
import { activityMonitor, type ActivityEntry } from "./activity.js";

const MAX_INLINE_CONTENT = 30000;

const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;
let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;

function normalizeProviderInput(value: unknown): SearchProvider | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  return normalized === "auto" || normalized === "exa" || normalized === "brave" ? normalized : "auto";
}

function normalizeQueryList(queryList: unknown[]): string[] {
  const normalized: string[] = [];
  for (const query of queryList) {
    if (typeof query !== "string") continue;
    const trimmed = query.trim();
    if (trimmed.length > 0) normalized.push(trimmed);
  }
  return normalized;
}

function stripLargeContent(results: ExtractedContent[]): ExtractedContent[] {
  return results.map((item) => ({
    ...item,
    content: item.content.length > MAX_INLINE_CONTENT
      ? item.content.slice(0, MAX_INLINE_CONTENT) + `\n\n[Content truncated. Use get_search_content to retrieve the full stored content.]`
      : item.content,
  }));
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
  let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
  output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
  return output;
}

function formatEntryLine(entry: ActivityEntry, theme: { fg: (color: string, text: string) => string }): string {
  const typeStr = entry.type === "api" ? "API" : "GET";
  const target = entry.type === "api" ? `"${entry.query || ""}"` : (entry.url?.replace(/^https?:\/\//, "") || "");
  const clipped = target.length > 32 ? target.slice(0, 29) + "..." : target;
  const duration = entry.endTime ? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s` : `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;

  let statusStr: string;
  let indicator: string;
  if (entry.error) {
    statusStr = "err";
    indicator = theme.fg("error", "✗");
  } else if (entry.status === null) {
    statusStr = "...";
    indicator = theme.fg("warning", "⋯");
  } else if (entry.status === 0) {
    statusStr = "abort";
    indicator = theme.fg("muted", "○");
  } else {
    statusStr = String(entry.status);
    indicator = entry.status >= 200 && entry.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗");
  }
  return `${typeStr.padEnd(4)} ${clipped.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`;
}

function updateWidget(ctx: ExtensionContext): void {
  const theme = ctx.ui.theme;
  const entries = activityMonitor.getEntries();
  const lines: string[] = [theme.fg("accent", "─── Web Access Activity " + "─".repeat(35))];
  if (entries.length === 0) lines.push(theme.fg("muted", "  No activity yet"));
  else for (const entry of entries) lines.push("  " + formatEntryLine(entry, theme));
  lines.push(theme.fg("accent", "─".repeat(60)));
  ctx.ui.setWidget("web-access-activity", new Text(lines.join("\n"), 0, 0));
}

function abortPendingFetches(): void {
  for (const controller of pendingFetches.values()) controller.abort();
  pendingFetches.clear();
}

function handleSessionChange(ctx: ExtensionContext): void {
  abortPendingFetches();
  clearCloneCache();
  sessionActive = true;
  restoreFromSession(ctx);
  widgetUnsubscribe?.();
  widgetUnsubscribe = null;
  activityMonitor.clear();
  if (widgetVisible) {
    widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
    updateWidget(ctx);
  }
}

export default function (pi: ExtensionAPI) {
  function storeAndPublishSearch(results: QueryResultData[]): string {
    const id = generateId();
    const data: StoredSearchData = { id, type: "search", timestamp: Date.now(), queries: results };
    storeResult(id, data);
    pi.appendEntry("web-search-results", data);
    return id;
  }

  function storeAndPublishFetch(urls: ExtractedContent[]): string {
    const id = generateId();
    const data: StoredSearchData = { id, type: "fetch", timestamp: Date.now(), urls };
    storeResult(id, data);
    pi.appendEntry("web-search-results", data);
    return id;
  }

  function startBackgroundFetch(urls: string[]): string | null {
    if (urls.length === 0) return null;
    const fetchId = generateId();
    const controller = new AbortController();
    pendingFetches.set(fetchId, controller);
    fetchAllContent(urls, controller.signal)
      .then((fetched) => {
        if (!sessionActive || !pendingFetches.has(fetchId)) return;
        const data: StoredSearchData = { id: fetchId, type: "fetch", timestamp: Date.now(), urls: fetched };
        storeResult(fetchId, data);
        pi.appendEntry("web-search-results", data);
        const ok = fetched.filter(f => !f.error).length;
        pi.sendMessage({ customType: "web-search-content-ready", content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}].`, display: true }, { triggerTurn: true });
      })
      .catch((err) => {
        if (!sessionActive || !pendingFetches.has(fetchId)) return;
        const message = err instanceof Error ? err.message : String(err);
        if (!message.toLowerCase().includes("abort")) {
          pi.sendMessage({ customType: "web-search-error", content: `Content fetch failed [${fetchId}]: ${message}`, display: true }, { triggerTurn: false });
        }
      })
      .finally(() => pendingFetches.delete(fetchId));
    return fetchId;
  }

  pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
  pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));
  pi.on("session_shutdown", () => {
    sessionActive = false;
    abortPendingFetches();
    clearCloneCache();
    clearResults();
    widgetUnsubscribe?.();
    widgetUnsubscribe = null;
    activityMonitor.clear();
    widgetVisible = false;
  });

  pi.registerShortcut("ctrl+shift+w", {
    description: "Toggle web access activity",
    handler: async (ctx) => {
      widgetVisible = !widgetVisible;
      if (widgetVisible) {
        widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
        updateWidget(ctx);
      } else {
        widgetUnsubscribe?.();
        widgetUnsubscribe = null;
        ctx.ui.setWidget("web-access-activity", null);
      }
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using Exa or Brave Search. Provider auto-selects Exa first, then Brave when BRAVE_API_KEY is configured. EXA_API_KEY and BRAVE_API_KEY may be set in .env.",
    promptSnippet: "Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles for broader coverage.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries'." })),
      queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence." })),
      numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
      includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content in the background." })),
      recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" })),
      domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
      provider: Type.Optional(StringEnum(["auto", "exa", "brave"], { description: "Search provider (default: auto)" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const rawQueryList: unknown[] = Array.isArray(params.queries) ? params.queries : (params.query !== undefined ? [params.query] : []);
      const queryList = normalizeQueryList(rawQueryList);
      if (queryList.length === 0) {
        return { content: [{ type: "text" as const, text: "Error: No query provided. Use 'query' or 'queries'." }], details: { error: "No query provided" } };
      }

      const searchResults: QueryResultData[] = [];
      const allUrls: string[] = [];
      const provider = normalizeProviderInput(params.provider);

      for (let i = 0; i < queryList.length; i++) {
        const query = queryList[i];
        onUpdate?.({ content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }], details: { phase: "search", progress: i / queryList.length, currentQuery: query } });
        try {
          const { answer, results, provider: actualProvider } = await search(query, {
            provider,
            numResults: params.numResults,
            recencyFilter: params.recencyFilter,
            domainFilter: params.domainFilter,
            includeContent: params.includeContent,
            signal,
          });
          searchResults.push({ query, answer, results, error: null, provider: actualProvider });
          for (const result of results) if (!allUrls.includes(result.url)) allUrls.push(result.url);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          searchResults.push({ query, answer: "", results: [], error: message, provider });
        }
      }

      let output = "";
      for (const result of searchResults) {
        if (queryList.length > 1) output += `## Query: "${result.query}"${result.provider ? ` (${result.provider})` : ""}\n\n`;
        if (result.error) output += `Error: ${result.error}\n\n`;
        else if (result.results.length === 0) output += "No results found.\n\n";
        else output += formatSearchSummary(result.results, result.answer) + "\n\n";
      }

      const fetchId = params.includeContent ? startBackgroundFetch(allUrls) : null;
      if (fetchId) output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
      const searchId = storeAndPublishSearch(searchResults);
      const successfulQueries = searchResults.filter(r => !r.error).length;
      const totalResults = searchResults.reduce((sum, r) => sum + r.results.length, 0);

      return {
        content: [{ type: "text" as const, text: output.trim() }],
        details: { queries: queryList, queryCount: queryList.length, successfulQueries, totalResults, includeContent: params.includeContent ?? false, fetchId, searchId },
      };
    },
  });

  pi.registerTool({
    name: "code_search",
    label: "Code Search",
    description: "Search for code examples, documentation, and API references via Exa MCP. No API key required.",
    promptSnippet: "Use for programming documentation, API, and code example searches.",
    parameters: Type.Object({
      query: Type.String({ description: "Programming question, API, library, or debugging topic" }),
      maxTokens: Type.Optional(Type.Number({ description: "Maximum tokens of context to return (default: 5000, max: 50000)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await executeCodeSearch(params.query, { maxTokens: params.maxTokens, signal });
      return { content: [{ type: "text" as const, text: result.content }], details: result.details };
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description: "Fetch URL(s) and extract readable content as markdown. Supports regular web pages, PDFs, and GitHub repositories. Account-dependent YouTube and video analysis are intentionally not included.",
    promptSnippet: "Use to extract readable content from URLs, PDFs, or GitHub repos.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Single URL" })),
      urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs" })),
      forceClone: Type.Optional(Type.Boolean({ description: "Clone GitHub repos that exceed the size threshold" })),
    }),
    async execute(_toolCallId, params, signal) {
      const rawUrls: unknown[] = Array.isArray(params.urls) ? params.urls : (params.url !== undefined ? [params.url] : []);
      const urls = normalizeQueryList(rawUrls);
      if (urls.length === 0) return { content: [{ type: "text" as const, text: "Error: No URL provided." }], details: { error: "No URL provided" } };
      const fetched = await fetchAllContent(urls, signal, { forceClone: params.forceClone });
      const fetchId = storeAndPublishFetch(fetched);
      const returned = stripLargeContent(fetched);
      const output = returned.map((item, index) => {
        const heading = urls.length > 1 ? `## ${index + 1}. ${item.title || item.url}\n${item.url}\n\n` : "";
        if (item.error) return `${heading}Error: ${item.error}`;
        return `${heading}# ${item.title || item.url}\n\n${item.content}`;
      }).join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text: `${output}\n\n---\nStored content ID: ${fetchId}` }], details: { fetchId, urlCount: urls.length, successCount: fetched.filter(f => !f.error).length } };
    },
  });

  pi.registerTool({
    name: "get_search_content",
    label: "Get Search Content",
    description: "Retrieve stored content from previous web_search or fetch_content calls.",
    parameters: Type.Object({
      responseId: Type.Optional(Type.String({ description: "Stored response ID" })),
      urlIndex: Type.Optional(Type.Number({ description: "URL index in a stored fetch response" })),
      url: Type.Optional(Type.String({ description: "URL to retrieve from stored content" })),
      query: Type.Optional(Type.String({ description: "Query to retrieve from stored search results" })),
      list: Type.Optional(Type.Boolean({ description: "List stored responses" })),
      delete: Type.Optional(Type.Boolean({ description: "Delete the matching stored response" })),
    }),
    async execute(_toolCallId, params) {
      if (params.list) {
        const rows = getAllResults().map(r => `${r.id}  ${r.type}  ${new Date(r.timestamp).toISOString()}  ${r.type === "search" ? `${r.queries?.length ?? 0} queries` : `${r.urls?.length ?? 0} urls`}`);
        return { content: [{ type: "text" as const, text: rows.length ? rows.join("\n") : "No stored web access results." }], details: { count: rows.length } };
      }

      if (!params.responseId) return { content: [{ type: "text" as const, text: "Error: responseId is required unless list=true." }], details: { error: "Missing responseId" } };
      if (params.delete) {
        const deleted = deleteResult(params.responseId);
        return { content: [{ type: "text" as const, text: deleted ? `Deleted ${params.responseId}` : `No stored response ${params.responseId}` }], details: { deleted } };
      }

      const stored = getResult(params.responseId);
      if (!stored) return { content: [{ type: "text" as const, text: `No stored response ${params.responseId}` }], details: { error: "Not found" } };

      if (stored.type === "fetch") {
        let item: ExtractedContent | undefined;
        if (typeof params.urlIndex === "number") item = stored.urls?.[params.urlIndex];
        else if (params.url) item = stored.urls?.find(u => u.url === params.url);
        else item = stored.urls?.[0];
        if (!item) return { content: [{ type: "text" as const, text: "No matching URL content found." }], details: { error: "Not found" } };
        return { content: [{ type: "text" as const, text: item.error ? `Error: ${item.error}` : `# ${item.title || item.url}\n\n${item.content}` }], details: { url: item.url, title: item.title, error: item.error } };
      }

      let query = stored.queries?.[0];
      if (params.query) query = stored.queries?.find(q => q.query === params.query);
      if (!query) return { content: [{ type: "text" as const, text: "No matching query found." }], details: { error: "Not found" } };
      return { content: [{ type: "text" as const, text: query.error ? `Error: ${query.error}` : formatSearchSummary(query.results, query.answer) }], details: { query: query.query, provider: query.provider, error: query.error } };
    },
  });
}
