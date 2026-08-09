import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SEARCH_TIMEOUT_MS = 60_000;

class OneLine implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return width > 0 ? [truncateToWidth(this.text, width)] : [];
  }

  invalidate(): void {}
}

function compactArg(value: string | undefined, fallback: string): string {
  return value ? value.replace(/\s+/g, " ") : fallback;
}

function normalizePath(value: string | undefined): string {
  if (!value) return ".";
  let path = value.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path || ".";
}

async function formatOutput(output: string, prefix: string) {
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) {
    return { text: output, truncated: false, fullOutputPath: undefined };
  }

  const directory = await mkdtemp(join(tmpdir(), `sz-pi-${prefix}-`));
  const fullOutputPath = join(directory, "output.txt");
  await writeFile(fullOutputPath, output, "utf8");
  const notice =
    `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    `Full output saved to: ${fullOutputPath}]`;
  return {
    text: `${truncation.content}\n\n${notice}`,
    truncated: true,
    fullOutputPath,
  };
}

function commandFailure(tool: string, execution: { code: number; stderr: string; killed?: boolean }) {
  if (execution.killed) return new Error(`${tool} search timed out`);
  const detail = execution.stderr.trim() || `exit code ${execution.code}`;
  return new Error(`${tool} search failed: ${detail}`);
}

export default function fileSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "find_files",
    label: "Find Files",
    description:
      "Find files and directories by name using fd. Respects ignore files by default. " +
      "Output is limited to 2,000 lines or 50KB; complete truncated output is saved to a temporary file.",
    promptSnippet: "Find files and directories by name",
    promptGuidelines: [
      "Use find_files for filename and directory discovery instead of shell find or recursive ls.",
      "Use search_text instead of find_files when searching inside files.",
    ],
    parameters: Type.Object({
      pattern: Type.Optional(
        Type.String({ description: "Filename regex, or a glob when glob is true" }),
      ),
      path: Type.Optional(
        Type.String({ description: "Directory to search; defaults to the working directory" }),
      ),
      type: Type.Optional(
        StringEnum(["file", "directory", "symlink"] as const, {
          description: "Limit results to one filesystem entry type",
        }),
      ),
      extension: Type.Optional(
        Type.String({ description: "File extension without a leading dot, such as ts" }),
      ),
      glob: Type.Optional(
        Type.Boolean({ description: "Interpret pattern as a glob instead of a regex" }),
      ),
      hidden: Type.Optional(
        Type.Boolean({ description: "Include hidden entries; defaults to false" }),
      ),
      max_depth: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 64, description: "Maximum directory depth" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10_000, description: "Maximum results; defaults to 1,000" }),
      ),
    }),

    renderCall(args, theme) {
      const pattern = compactArg(args.pattern, args.glob ? "*" : ".");
      const path = compactArg(args.path, ".");
      return new OneLine(
        `${theme.fg("toolTitle", "find_files")} ${theme.fg("accent", pattern)}${theme.fg("toolOutput", ` in ${path}`)}`,
      );
    },

    renderResult(result, { expanded }, theme, context) {
      if (!expanded) return new Container();
      const output = result.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (!output) return new Container();
      const color = context.isError ? "error" : "toolOutput";
      return new Text(
        `\n${output.split("\n").map((line) => theme.fg(color, line)).join("\n")}`,
        0,
        0,
      );
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["--color", "never", "--max-results", String(params.limit ?? 1_000)];
      if (params.glob) args.push("--glob");
      if (params.hidden) args.push("--hidden");
      if (params.max_depth !== undefined) args.push("--max-depth", String(params.max_depth));
      if (params.extension) args.push("--extension", params.extension.replace(/^\./, ""));
      if (params.type) {
        const typeFlag = { file: "f", directory: "d", symlink: "l" }[params.type];
        args.push("--type", typeFlag);
      }
      args.push("--", params.pattern || (params.glob ? "*" : "."), normalizePath(params.path));

      const execution = await pi.exec("fd", args, {
        cwd: ctx.cwd,
        signal,
        timeout: SEARCH_TIMEOUT_MS,
      });
      if (execution.code !== 0) throw commandFailure("fd", execution);
      if (!execution.stdout.trim()) {
        return {
          content: [{ type: "text" as const, text: "No files found" }],
          details: { resultCount: 0, truncated: false, fullOutputPath: undefined },
        };
      }

      const formatted = await formatOutput(execution.stdout, "find-files");
      const resultCount = execution.stdout.trimEnd().split(/\r?\n/).length;
      return {
        content: [{ type: "text" as const, text: formatted.text }],
        details: {
          resultCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "search_text",
    label: "Search Text",
    description:
      "Search file contents using ripgrep. Uses smart-case matching and respects ignore files by default. " +
      "Output is limited to 2,000 lines or 50KB; complete truncated output is saved to a temporary file.",
    promptSnippet: "Search text inside workspace files",
    promptGuidelines: [
      "Use search_text as the primary tool for searching file contents instead of shell grep.",
      "Use find_files instead of search_text when looking for files by name.",
      "Use bash when search results need a shell pipeline or complex post-processing.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search for" }),
      path: Type.Optional(
        Type.String({ description: "File or directory to search; defaults to the working directory" }),
      ),
      glob: Type.Optional(
        Type.String({ description: "Only search files matching this glob, such as *.ts or src/**" }),
      ),
      file_type: Type.Optional(
        Type.String({ description: "Ripgrep file type such as ts, js, py, or rust" }),
      ),
      case_sensitive: Type.Optional(
        Type.Boolean({ description: "Force case-sensitive or case-insensitive matching; defaults to smart-case" }),
      ),
      fixed_strings: Type.Optional(
        Type.Boolean({ description: "Treat pattern as literal text instead of a regular expression" }),
      ),
      hidden: Type.Optional(
        Type.Boolean({ description: "Include hidden files; defaults to false" }),
      ),
      context: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 20, description: "Context lines around each match" }),
      ),
      max_matches_per_file: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 1_000, description: "Maximum matches in each file; defaults to 100" }),
      ),
    }),

    renderCall(args, theme) {
      const pattern = JSON.stringify(compactArg(args.pattern, ""));
      const path = compactArg(args.path, ".");
      return new OneLine(
        `${theme.fg("toolTitle", "search_text")} ${theme.fg("accent", pattern)}${theme.fg("toolOutput", ` in ${path}`)}`,
      );
    },

    renderResult(result, { expanded }, theme, context) {
      if (!expanded) return new Container();
      const output = result.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (!output) return new Container();
      const color = context.isError ? "error" : "toolOutput";
      return new Text(
        `\n${output.split("\n").map((line) => theme.fg(color, line)).join("\n")}`,
        0,
        0,
      );
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = [
        "--color",
        "never",
        "--line-number",
        "--column",
        "--with-filename",
        "--max-count",
        String(params.max_matches_per_file ?? 100),
      ];
      if (params.case_sensitive === true) args.push("--case-sensitive");
      else if (params.case_sensitive === false) args.push("--ignore-case");
      else args.push("--smart-case");
      if (params.fixed_strings) args.push("--fixed-strings");
      if (params.hidden) args.push("--hidden");
      if (params.context !== undefined) args.push("--context", String(params.context));
      if (params.glob) args.push("--glob", params.glob);
      if (params.file_type) args.push("--type", params.file_type);
      args.push("--", params.pattern, normalizePath(params.path));

      const execution = await pi.exec("rg", args, {
        cwd: ctx.cwd,
        signal,
        timeout: SEARCH_TIMEOUT_MS,
      });
      if (execution.code === 1 && !execution.stdout.trim()) {
        return {
          content: [{ type: "text" as const, text: "No matches found" }],
          details: { outputLines: 0, truncated: false, fullOutputPath: undefined },
        };
      }
      if (execution.code !== 0) throw commandFailure("rg", execution);

      const formatted = await formatOutput(execution.stdout, "search-text");
      const outputLines = execution.stdout.trimEnd().split(/\r?\n/).length;
      return {
        content: [{ type: "text" as const, text: formatted.text }],
        details: {
          outputLines,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      };
    },
  });
}
