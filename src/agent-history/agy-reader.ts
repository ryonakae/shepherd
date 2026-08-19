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

      if (type === "USER_INPUT") {
        const text = textFromContent(entry.value.content);
        if (text) {
          messages.push({ ref: refValue, role: "user", text, timestamp });
        }
        continue;
      }

      if (type === "PLANNER_RESPONSE") {
        const text = textFromContent(entry.value.content);
        if (source === "MODEL" && text) {
          messages.push({ ref: refValue, role: "assistant", text, timestamp });
          continue;
        }

        const toolCalls = Array.isArray(entry.value.tool_calls) ? entry.value.tool_calls : [];
        if (toolCalls.length > 0) {
          const firstCall = record(toolCalls[0]);
          const toolName = stringValue(firstCall.name) ?? "unknown";
          const args = firstCall.args;
          const text = formatToolCallText(toolName, args);
          const compact = compactToolResult({ isError: false, ref: refValue, text, toolName });
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

function formatToolCallText(toolName: string, args: unknown): string {
  if (typeof args === "string") {
    const trimmed = args.trim();
    return trimmed.length > 0 ? `${toolName}: ${trimmed}` : toolName;
  }
  if (typeof args === "object" && args !== null) {
    const serialized = JSON.stringify(args);
    return serialized && serialized !== "{}" ? `${toolName}: ${serialized}` : toolName;
  }
  return toolName;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
