import { readFile } from "node:fs/promises";
import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import { type AgentHistoryReader, compactFromMessages, limitMessages } from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

export class GeminiHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "gemini-json" && Boolean(ref.path ?? ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const path = ref.path ?? ref.value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return [];
    }
    const records = geminiMessages(parsed);
    const messages: AgentHistoryMessage[] = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      const type = stringValue(record.type);
      const id = stringValue(record.id);
      const timestamp =
        timestampFrom(record.timestamp) ??
        timestampFrom(record.time) ??
        timestampFrom(record.createdAt);
      const refValue = messageRef(path, id ?? undefined, index + 1);

      if (type === "user") {
        const text = geminiText(record.content);
        if (text) messages.push({ ref: refValue, role: "user", text, timestamp });
        continue;
      }

      if (type === "gemini" || type === "assistant" || type === "model") {
        const text = geminiText(record.content);
        if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
        continue;
      }

      if (type === "tool" || type === "tool_result" || type === "tool_response") {
        const toolName = stringValue(record.tool) ?? stringValue(record.name) ?? "unknown";
        const output =
          record.output ?? record.response ?? record.content ?? record.result ?? record;
        const text = typeof output === "string" ? output : JSON.stringify(output);
        const isError = record.isError === true || record.error !== undefined;
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

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

function geminiMessages(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(record).filter((item) => Object.keys(item).length > 0);
  const root = record(value);
  const messages = root.messages;
  return Array.isArray(messages)
    ? messages.map(record).filter((item) => Object.keys(item).length > 0)
    : [];
}

function geminiText(value: unknown): string | null {
  if (typeof value === "string") return value;
  const text = textFromContent(value);
  if (text) return text;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        const block = record(item);
        return stringValue(block.text) ?? stringValue(block.content) ?? "";
      })
      .filter((part) => part.trim().length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
