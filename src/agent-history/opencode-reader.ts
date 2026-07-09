import { DatabaseSync } from "node:sqlite";
import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import { type AgentHistoryReader, compactFromMessages, limitMessages } from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

type OpenCodeRow = {
  message_id: string;
  message_time: number;
  part_data: string | null;
  part_id: string | null;
  part_time: number | null;
  role: string | null;
};

export class OpenCodeHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "opencode-sqlite" && Boolean(ref.path) && Boolean(ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const dbPath = ref.path;
    if (!dbPath) return [];
    let sqlite: DatabaseSync | null = null;
    try {
      sqlite = new DatabaseSync(dbPath, { readOnly: true });
      const rows = sqlite
        .prepare(`
          select
            m.id as message_id,
            m.time_created as message_time,
            json_extract(m.data, '$.role') as role,
            p.id as part_id,
            p.time_created as part_time,
            p.data as part_data
          from message m
          left join part p on p.message_id = m.id
          where m.session_id = ?
          order by m.time_created asc, p.time_created asc, p.id asc
        `)
        .all(ref.value) as OpenCodeRow[];

      const messages: AgentHistoryMessage[] = [];
      for (const row of rows) {
        if (!row.part_data) continue;
        const part = parseJsonRecord(row.part_data);
        const partType = stringValue(part.type);
        const timestamp = timestampFrom(row.part_time ?? row.message_time);
        const refValue = messageRef(dbPath, row.part_id ?? row.message_id, 0);

        if (partType === "text") {
          const role = row.role === "assistant" || row.role === "user" ? row.role : null;
          const text = stringValue(part.text) ?? textFromContent(part.content);
          if (role && text) messages.push({ ref: refValue, role, text, timestamp });
          continue;
        }

        if (partType === "tool") {
          const toolName = stringValue(part.tool) ?? "unknown";
          const state = record(part.state);
          const output = state.output ?? state.error ?? part.output ?? part.content ?? part;
          const text = typeof output === "string" ? output : JSON.stringify(output);
          const isError = Boolean(state.error) || stringValue(state.status) === "error";
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
    } catch {
      return [];
    } finally {
      sqlite?.close();
    }
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
