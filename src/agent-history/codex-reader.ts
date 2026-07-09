import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import {
  type AgentHistoryReader,
  compactFromMessages,
  limitMessages,
  readJsonl,
} from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

export class CodexHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "codex-jsonl" && Boolean(ref.path ?? ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const path = ref.path ?? ref.value;
    const messages: AgentHistoryMessage[] = [];
    const toolNamesByCallId = new Map<string, string>();

    for (const entry of await readJsonl(path)) {
      const type = stringValue(entry.value.type);
      const payload = record(entry.value.payload);
      const payloadType = stringValue(payload.type);
      const id =
        stringValue(payload.id) ?? stringValue(payload.call_id) ?? stringValue(entry.value.id);
      const timestamp =
        timestampFrom(payload.timestamp) ??
        timestampFrom(payload.started_at) ??
        timestampFrom(entry.value.timestamp);
      const refValue = messageRef(path, id ?? undefined, entry.line);

      if (type === "event_msg") {
        if (payloadType === "user_message") {
          const text = stringValue(payload.message);
          if (text && !isSystemCodexMessage(text)) {
            messages.push({ ref: refValue, role: "user", text, timestamp });
          }
          continue;
        }
        if (payloadType === "agent_message") {
          const text = stringValue(payload.message);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
          continue;
        }
        if (payloadType === "task_complete") {
          const text = stringValue(payload.last_agent_message);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
          continue;
        }
      }

      if (type !== "response_item") continue;

      if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        const callId = stringValue(payload.call_id);
        const name = stringValue(payload.name);
        if (callId && name) toolNamesByCallId.set(callId, name);
        continue;
      }

      if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
        const callId = stringValue(payload.call_id);
        const toolName = (callId ? toolNamesByCallId.get(callId) : null) ?? "unknown";
        const text = textFromCodexOutput(payload.output);
        const compact = compactToolResult({ isError: false, ref: refValue, text, toolName });
        messages.push({
          compact,
          ref: refValue,
          role: "tool_result",
          text: compact.text,
          timestamp,
          toolName,
        });
        continue;
      }

      if (payloadType === "message") {
        const role = stringValue(payload.role);
        if (role === "developer") continue;
        if (role === "user") {
          const text = textFromCodexContent(payload.content, "input_text");
          if (text && !isSystemCodexMessage(text)) {
            messages.push({ ref: refValue, role: "user", text, timestamp });
          }
          continue;
        }
        if (role === "assistant") {
          const text =
            textFromCodexContent(payload.content, "output_text") ??
            textFromContent(payload.content);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
        }
      }
    }

    return limitMessages(messages, options.limit);
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

function textFromCodexContent(content: unknown, blockType: string): string | null {
  if (!Array.isArray(content)) return typeof content === "string" ? content : null;
  const parts = content
    .map((block) => {
      const item = record(block);
      if (item.type !== blockType) return "";
      return stringValue(item.text) ?? "";
    })
    .filter((part) => part.trim().length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

function textFromCodexOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}

function isSystemCodexMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>") || trimmed.startsWith("<user_instructions>");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
