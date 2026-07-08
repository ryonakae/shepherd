import { readFile } from "node:fs/promises";
import type {
  AgentHistoryMessage,
  AgentHistoryRef,
  CompactAgentHistory,
} from "@/observability/contracts.js";

export type JsonlEntry = { line: number; value: Record<string, unknown> };

export type AgentHistoryReader = {
  canRead(ref: AgentHistoryRef): boolean;
  read(ref: AgentHistoryRef, options: { limit?: number }): Promise<AgentHistoryMessage[]>;
  readCompact(ref: AgentHistoryRef): Promise<CompactAgentHistory>;
};

export async function readJsonl(path: string): Promise<JsonlEntry[]> {
  const content = await readFile(path, "utf8");
  const entries: JsonlEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        entries.push({ line: index + 1, value: parsed as Record<string, unknown> });
      }
    } catch {}
  }
  return entries;
}

export function compactFromMessages(
  ref: AgentHistoryRef,
  messages: AgentHistoryMessage[],
): CompactAgentHistory {
  const lastUser = lastByRole(messages, "user");
  const lastAssistant = lastByRole(messages, "assistant");
  const lastTool = [...messages].reverse().find((message) => message.role === "tool_result");
  return {
    historyRef: ref,
    lastAssistantMessage: lastAssistant ? excerpt(lastAssistant) : null,
    lastToolResult: lastTool?.compact ?? null,
    lastUserMessage: lastUser ? excerpt(lastUser) : null,
    messageCount: messages.length,
    source: ref.source,
    updatedAt: [...messages].reverse().find((message) => message.timestamp)?.timestamp ?? null,
  };
}

export function limitMessages(
  messages: AgentHistoryMessage[],
  limit: number | undefined,
): AgentHistoryMessage[] {
  if (!limit || messages.length <= limit) return messages;
  return messages.slice(messages.length - limit);
}

function lastByRole(
  messages: AgentHistoryMessage[],
  role: AgentHistoryMessage["role"],
): AgentHistoryMessage | undefined {
  return [...messages].reverse().find((message) => message.role === role);
}

function excerpt(message: AgentHistoryMessage) {
  return { ref: message.ref, text: message.text, timestamp: message.timestamp };
}
