import { readFile } from "node:fs/promises";
import type { AgentSessionRef, WorkerToolSummary } from "@/observability/contracts.js";
import type { TranscriptAdapter, TranscriptBackfill } from "@/observability/runtime-adapter.js";

const maxExcerptLength = 4096;
const blockedPattern = /\b(blocked|ブロック|確認が必要|cannot proceed|need input)\b/i;
const completionPattern = /\b(done|completed|完了|実装しました|修正しました)\b/i;

type PiEntry = {
  id?: string;
  message?: {
    content?: unknown;
    isError?: boolean;
    role?: string;
    toolCallId?: string;
    toolName?: string;
  };
  timestamp?: string;
  type?: string;
};

export class PiTranscriptAdapter implements TranscriptAdapter {
  canRead(session: AgentSessionRef): boolean {
    return session.source === "herdr:pi" && session.agent === "pi" && session.kind === "path";
  }

  async read(session: AgentSessionRef): Promise<TranscriptBackfill> {
    if (!this.canRead(session)) {
      throw new Error("Unsupported Pi transcript session reference");
    }

    const content = await readFile(session.value, "utf8");
    let lastAssistant: { entry: PiEntry; text: string } | null = null;
    let lastTool: { entry: PiEntry; summary: WorkerToolSummary } | null = null;

    for (const line of content.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      const entry = parseEntry(line);
      if (entry?.type !== "message") {
        continue;
      }
      if (entry.message?.role === "assistant") {
        const text = textFromContent(entry.message.content);
        if (text) {
          lastAssistant = { entry, text: truncate(text) };
        }
      }
      if (entry.message?.role === "toolResult") {
        lastTool = {
          entry,
          summary: {
            isError: entry.message.isError === true,
            name: entry.message.toolName ?? "unknown",
            outputExcerpt: truncate(textFromContent(entry.message.content) ?? ""),
            toolCallId: entry.message.toolCallId ?? entry.id ?? "unknown",
          },
        };
      }
    }

    const statusHints: TranscriptBackfill["statusHints"] = {};
    if (lastAssistant?.text && blockedPattern.test(lastAssistant.text)) {
      statusHints.blockedReason = lastAssistant.text;
      statusHints.needsInput = true;
    }
    if (lastAssistant?.text && completionPattern.test(lastAssistant.text)) {
      statusHints.completion = lastAssistant.text;
    }

    return {
      evidence: [
        ...(lastTool
          ? [
              {
                ...(lastTool.summary.outputExcerpt
                  ? { excerpt: lastTool.summary.outputExcerpt }
                  : {}),
                ref: `${session.value}#entry=${lastTool.entry.id ?? "unknown"}`,
                source: "transcript" as const,
                ...(lastTool.entry.timestamp ? { timestamp: lastTool.entry.timestamp } : {}),
              },
            ]
          : []),
        ...(lastAssistant
          ? [
              {
                excerpt: lastAssistant.text,
                ref: `${session.value}#entry=${lastAssistant.entry.id ?? "unknown"}`,
                source: "transcript" as const,
                ...(lastAssistant.entry.timestamp
                  ? { timestamp: lastAssistant.entry.timestamp }
                  : {}),
              },
            ]
          : []),
      ],
      lastMessageExcerpt: lastAssistant?.text ?? null,
      lastTool: lastTool?.summary ?? null,
      statusHints,
    };
  }
}

function parseEntry(line: string): PiEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as PiEntry) : null;
  } catch {
    return null;
  }
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (typeof block === "object" && block !== null && "text" in block) {
        const value = (block as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text.length > 0 ? text : null;
}

function truncate(value: string): string {
  return value.length > maxExcerptLength ? value.slice(0, maxExcerptLength) : value;
}
