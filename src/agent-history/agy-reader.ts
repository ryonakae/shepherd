import { join } from "node:path";
import type {
  AgentHistoryMessage,
  AgentHistoryRef,
  CompactAgentHistory,
} from "@/observability/contracts.js";
import {
  type AgentHistoryReader,
  compactFromMessages,
  limitMessages,
  readJsonl,
} from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

const ignoredEntryTypes = new Set([
  "attachment",
  "checkpoint",
  "conversation_history",
  "ephemeral_message",
  "file-history-snapshot",
  "mode",
  "permission-mode",
  "system_message",
]);

const knownToolExecutionTypes = new Set([
  "ask_question",
  "call_mcp_tool",
  "command_output",
  "edit_file",
  "error_message",
  "execute_command",
  "find_by_name",
  "generate_image",
  "grep_search",
  "list_dir",
  "list_directory",
  "list_resources",
  "read_resource",
  "read_url_content",
  "replace_file_content",
  "run_command",
  "search_web",
  "tool_call_result",
  "tool_result",
  "view_file",
  "write_file",
  "write_to_file",
]);

function isKnownToolExecutionType(type: string): boolean {
  return knownToolExecutionTypes.has(type.toLowerCase());
}

export class AgyHistoryReader implements AgentHistoryReader {
  private readonly homeDir?: string;

  constructor(options: { homeDir?: string } = {}) {
    if (options.homeDir !== undefined) {
      this.homeDir = options.homeDir;
    }
  }

  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "agy-jsonl" && Boolean(ref.path ?? ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { homeDir?: string; limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const homeDir = options.homeDir ?? this.homeDir;
    const path = resolveAgyTranscriptPath(ref, homeDir !== undefined ? { homeDir } : {});
    if (!path) return [];

    let entries: ReturnType<typeof readJsonl> extends Promise<infer T> ? T : never;
    try {
      entries = await readJsonl(path);
    } catch {
      return [];
    }

    const messages: AgentHistoryMessage[] = [];
    const pendingToolCalls: string[] = [];

    for (const entry of entries) {
      const type = stringValue(entry.value.type);
      const source = stringValue(entry.value.source);
      const id =
        stringValue(entry.value.id) ??
        (typeof entry.value.step_index === "number" || typeof entry.value.step_index === "string"
          ? String(entry.value.step_index)
          : undefined);
      const timestamp =
        timestampFrom(entry.value.created_at) ?? timestampFrom(entry.value.timestamp);
      const refValue = messageRef(path, id, entry.line);

      if (!type || isIgnoredEntry(type, source)) {
        continue;
      }

      if (type === "USER_INPUT") {
        pendingToolCalls.length = 0;
        const text = textFromContent(entry.value.content);
        if (text) {
          messages.push({ ref: refValue, role: "user", text, timestamp });
        }
        continue;
      }

      if (type === "PLANNER_RESPONSE") {
        const text = textFromContent(entry.value.content);
        if (text) {
          messages.push({ ref: refValue, role: "assistant", text, timestamp });
        }

        const toolCalls = Array.isArray(entry.value.tool_calls) ? entry.value.tool_calls : [];
        for (const call of toolCalls) {
          const callRecord = record(call);
          const name = stringValue(callRecord.name) ?? "unknown";
          pendingToolCalls.push(name);
        }
        continue;
      }

      if (!isKnownToolExecutionType(type)) {
        continue;
      }

      const toolName = pendingToolCalls.shift() ?? inferToolName(type, entry.value);

      const text = textFromToolResult(entry.value);
      if (text !== null) {
        const isError = isToolResultError(entry.value);
        const compact = compactToolResult({ isError, ref: refValue, text, toolName });
        messages.push({
          compact,
          ref: refValue,
          role: "tool_result",
          text: compact.text,
          timestamp,
          toolName,
        });
      }
    }

    return limitMessages(messages, options.limit);
  }

  async readCompact(ref: AgentHistoryRef): Promise<CompactAgentHistory> {
    return compactFromMessages(ref, await this.read(ref));
  }
}

export function resolveAgyTranscriptPath(
  ref: AgentHistoryRef,
  options: { homeDir?: string } = {},
): string {
  if (ref.path && ref.path.length > 0) {
    return ref.path;
  }
  const value = ref.value;
  if (!value) return "";
  if (value.includes("/") || value.endsWith(".jsonl")) {
    return value;
  }
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  return join(
    homeDir,
    ".gemini",
    "antigravity-cli",
    "brain",
    value,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

function isIgnoredEntry(type: string, source: string | null): boolean {
  if (source === "SYSTEM" && type !== "ERROR_MESSAGE") return true;
  return ignoredEntryTypes.has(type.toLowerCase());
}

function inferToolName(type: string, entry: Record<string, unknown>): string {
  const explicit =
    stringValue(entry.tool_name) ?? stringValue(entry.name) ?? stringValue(entry.tool);
  if (explicit) return explicit;
  if (type === "ERROR_MESSAGE" || type === "GENERIC") return "unknown";
  return type.toLowerCase();
}

function textFromToolResult(value: Record<string, unknown>): string | null {
  const text = textFromContent(value.content);
  if (text) return text;
  if (typeof value.error === "string" && value.error.length > 0) return value.error;
  if (value.error !== undefined && value.error !== null) return JSON.stringify(value.error);
  if (typeof value.exit_code === "number") return `exit code ${value.exit_code}`;
  return null;
}

function isToolResultError(value: Record<string, unknown>): boolean {
  if (value.type === "ERROR_MESSAGE") return true;
  if (stringValue(value.status) === "ERROR") return true;
  if (typeof value.exit_code === "number" && value.exit_code !== 0) return true;
  if (value.error !== undefined && value.error !== null) return true;
  return false;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
