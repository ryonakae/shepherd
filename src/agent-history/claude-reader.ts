import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import {
  type AgentHistoryReader,
  compactFromMessages,
  limitMessages,
  readJsonl,
} from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

export class ClaudeHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "claude-jsonl" && Boolean(ref.path ?? ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const path = ref.path ?? ref.value;
    const messages: AgentHistoryMessage[] = [];
    for (const entry of await readJsonl(path)) {
      const type = stringValue(entry.value.type);
      if (!type || ignoredTypes.has(type)) continue;
      const message = record(entry.value.message);
      const uuid = stringValue(entry.value.uuid) ?? stringValue(entry.value.id);
      const timestamp = timestampFrom(entry.value.timestamp) ?? timestampFrom(message.timestamp);
      const refValue = messageRef(path, uuid ?? undefined, entry.line);
      const role =
        stringValue(message.role) ?? (type === "assistant" || type === "user" ? type : null);

      const toolResult = toolResultFrom(entry.value, message);
      if (toolResult) {
        const compact = compactToolResult({
          isError: toolResult.isError,
          ref: refValue,
          text: toolResult.text,
          toolName: toolResult.toolName,
        });
        messages.push({
          compact,
          ref: refValue,
          role: "tool_result",
          text: compact.text,
          timestamp,
          toolName: toolResult.toolName,
        });
        continue;
      }

      if (role === "user" || role === "assistant") {
        const text = textFromContent(message.content);
        if (text) messages.push({ ref: refValue, role, text, timestamp });
      }
    }
    return limitMessages(messages, options.limit);
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

const ignoredTypes = new Set(["attachment", "file-history-snapshot", "mode", "permission-mode"]);

function toolResultFrom(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): { isError: boolean; text: string; toolName: string } | null {
  const topToolUseResult = entry.toolUseResult;
  if (topToolUseResult !== undefined && topToolUseResult !== null) {
    return {
      isError: entry.isError === true || message.isError === true,
      text:
        typeof topToolUseResult === "string" ? topToolUseResult : JSON.stringify(topToolUseResult),
      toolName: stringValue(entry.toolName) ?? stringValue(message.toolName) ?? "unknown",
    };
  }

  const content = message.content;
  if (Array.isArray(content)) {
    const toolBlocks = content.filter((block) => {
      if (typeof block !== "object" || block === null) return false;
      const record = block as Record<string, unknown>;
      return record.type === "tool_result" || record.type === "tool_result_delta";
    });
    if (toolBlocks.length > 0) {
      return {
        isError: toolBlocks.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            (block as { is_error?: unknown }).is_error === true,
        ),
        text: toolBlocks
          .map((block) => textFromContent(record(block).content) ?? JSON.stringify(block))
          .join("\n"),
        toolName:
          stringValue(record(toolBlocks[0]).name) ??
          stringValue(record(toolBlocks[0]).toolName) ??
          "unknown",
      };
    }
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
