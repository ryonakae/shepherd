import type { CompactToolResult } from "@/observability/contracts.js";
import { sanitizeText, truncateChars } from "./text.js";

const maxToolResultChars = 1600;
const passthroughMarker = "[SHEPHERD:TRUNCATED_TOOL_RESULT]";

type Mode = CompactToolResult["compaction"]["mode"];

export function compactToolResult(input: {
  isError: boolean;
  ref: string;
  text: string;
  toolName: string;
}): CompactToolResult {
  const sanitized = sanitizeText(input.text).text;
  const originalChars = [...input.text].length;
  const { mode, text } = compactText(input.toolName, sanitized);
  const bounded = boundWithMarker(text, mode);
  return {
    compaction: {
      mode,
      originalChars,
      returnedChars: [...bounded].length,
    },
    isError: input.isError,
    ref: input.ref,
    text: bounded,
    toolName: input.toolName,
  };
}

function compactText(toolName: string, text: string): { mode: Mode; text: string } {
  const failure = failureFocus(text);
  if (failure) return { mode: "failure_focus", text: failure };

  const web = webSources(toolName, text);
  if (web) return { mode: "web_sources", text: web };

  const structured = structuredSummary(text);
  if (structured) return { mode: "structured_summary", text: structured };

  const grouped = dedupeLines(text);
  if (grouped && grouped !== text) return { mode: "grouped_matches", text: grouped };

  return { mode: "truncated_passthrough", text };
}

function failureFocus(text: string): string | null {
  if (
    !/(FAIL|Failed|AssertionError|Test Files|Tests|ERR_PNPM|expected|received|Error:)/i.test(text)
  ) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const selected: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (
      /(FAIL|Failed|AssertionError|Test Files|Tests|ERR_PNPM|expected|received|Error:|\bnot ok\b)/i.test(
        line,
      )
    ) {
      selected.push(line);
      for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
        const neighbor = lines[next] ?? "";
        if (/^\s+/.test(neighbor) || /at\s+/.test(neighbor) || neighbor.trim().length === 0) {
          selected.push(neighbor);
        }
      }
    }
    if (selected.length >= 40) break;
  }
  const compact = selected
    .filter((line, index, array) => line.trim() !== "" || array[index - 1]?.trim() !== "")
    .join("\n")
    .trim();
  return compact.length > 0 ? compact : null;
}

function webSources(toolName: string, text: string): string | null {
  if (!/(web_search|fetch_content|mcp)/i.test(toolName) && !/https?:\/\//.test(text)) return null;
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  for (const line of lines) {
    if (/https?:\/\//.test(line) || /^\s*[-*#]/.test(line) || /title|source|url/i.test(line)) {
      result.push(line.trim());
    }
    if (result.length >= 30) break;
  }
  return result.length > 0 ? result.join("\n") : null;
}

function structuredSummary(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const sample = parsed
        .slice(0, 5)
        .map((item) => describeValue(item))
        .join(", ");
      return `array(${parsed.length}) [${sample}]`;
    }
    if (typeof parsed === "object" && parsed !== null) {
      const entries = Object.entries(parsed as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, value]) => `${key}: ${describeValue(value)}`);
      return entries.join("\n");
    }
  } catch {
    return null;
  }
  return null;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object" && value !== null) return `object(${Object.keys(value).length})`;
  return typeof value;
}

function dedupeLines(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 4) return null;
  const counts = new Map<string, { count: number; line: string }>();
  for (const line of lines) {
    const key = line.trim().replace(/\d+/g, "#");
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { count: 1, line });
  }
  if (![...counts.values()].some((item) => item.count > 1)) return null;
  return [...counts.values()]
    .slice(0, 80)
    .map((item) => (item.count > 1 ? `${item.line} (x${item.count})` : item.line))
    .join("\n");
}

function boundWithMarker(text: string, mode: Mode): string {
  if ([...text].length <= maxToolResultChars) return text;
  const marker = mode === "truncated_passthrough" ? `\n${passthroughMarker}` : "";
  return `${truncateChars(text, maxToolResultChars)}${marker}`;
}
