import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import {
  type AgentHistoryReader,
  compactFromMessages,
  limitMessages,
  readJsonl,
} from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

export class PiHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "pi-jsonl" && Boolean(ref.path ?? ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const path = ref.path ?? ref.value;
    const messages: AgentHistoryMessage[] = [];
    for (const entry of await readJsonl(path)) {
      const message = record(entry.value.message);
      const role = stringValue(message.role);
      if (entry.value.type !== "message" || !role) continue;
      const id = stringValue(entry.value.id);
      const timestamp = timestampFrom(entry.value.timestamp) ?? timestampFrom(message.timestamp);
      const refValue = messageRef(path, id ?? undefined, entry.line);
      if (role === "user" || role === "assistant") {
        const text = textFromContent(message.content);
        if (text) messages.push({ ref: refValue, role, text, timestamp });
      }
      if (role === "toolResult") {
        const text = textFromContent(message.content) ?? "";
        const toolName = stringValue(message.toolName) ?? "unknown";
        messages.push({
          compact: compactToolResult({
            isError: message.isError === true,
            ref: refValue,
            text,
            toolName,
          }),
          ref: refValue,
          role: "tool_result",
          text: compactToolResult({
            isError: message.isError === true,
            ref: refValue,
            text,
            toolName,
          }).text,
          timestamp,
          toolName,
        });
      }
    }
    return limitMessages(messages, options.limit);
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
