import { stat } from "node:fs/promises";
import type { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import type { CompactAgentHistory } from "@/observability/contracts.js";
import { ClaudeHistoryReader } from "./claude-reader.js";
import { type AgentHistoryLookupInput, discoverAgentHistory } from "./discovery.js";
import { PiHistoryReader } from "./pi-reader.js";
import type { AgentHistoryReader } from "./readers.js";

export const agentHistoryFormatterVersion = "agent-history-v1";

type CacheLike = Pick<AgentHistoryCacheStore, "getFresh" | "put">;

export function createAgentHistoryService(
  options: { cache?: CacheLike; homeDir?: string; readers?: AgentHistoryReader[] } = {},
) {
  const readers = options.readers ?? [new PiHistoryReader(), new ClaudeHistoryReader()];

  return {
    async discover(input: AgentHistoryLookupInput) {
      return discoverAgentHistory({
        ...input,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      });
    },

    async getCompactHistory(input: AgentHistoryLookupInput): Promise<CompactAgentHistory> {
      const historyRef = await discoverAgentHistory({
        ...input,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      });
      if (!historyRef) return emptyCompactHistory();
      const reader = readers.find((candidate) => candidate.canRead(historyRef));
      if (!reader) return emptyCompactHistory(historyRef.source);
      const path = historyRef.path ?? historyRef.value;
      const cacheSourcePath = cacheSourcePathForRef(historyRef);
      const stats = await stat(path).catch(() => null);
      if (stats && options.cache) {
        const cached = options.cache.getFresh({
          formatterVersion: agentHistoryFormatterVersion,
          sourceMtimeMs: Math.trunc(stats.mtimeMs),
          sourcePath: cacheSourcePath,
          sourceSize: stats.size,
        });
        if (cached) return cached.compactHistory;
      }
      const compact = await reader.readCompact(historyRef);
      if (stats && options.cache) {
        options.cache.put({
          compactHistory: compact,
          formatterVersion: agentHistoryFormatterVersion,
          historyRef,
          sourceMtimeMs: Math.trunc(stats.mtimeMs),
          sourcePath: cacheSourcePath,
          sourceSize: stats.size,
        });
      }
      return compact;
    },

    async read(input: AgentHistoryLookupInput, readOptions: { limit: number }) {
      const historyRef = await discoverAgentHistory({
        ...input,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      });
      if (!historyRef) return { historyRef: null, messages: [] };
      const reader = readers.find((candidate) => candidate.canRead(historyRef));
      if (!reader) return { historyRef, messages: [] };
      return { historyRef, messages: await reader.read(historyRef, readOptions) };
    },
  };
}

export type AgentHistoryService = ReturnType<typeof createAgentHistoryService>;

export function cacheSourcePathForRef(historyRef: {
  kind?: string;
  path?: string;
  source: string;
  value: string;
}): string {
  const path = historyRef.path ?? historyRef.value;
  return historyRef.source === "opencode-sqlite" ? `${path}#session=${historyRef.value}` : path;
}

export function emptyCompactHistory(source: string | null = null): CompactAgentHistory {
  return {
    historyRef: null,
    lastAssistantMessage: null,
    lastToolResult: null,
    lastUserMessage: null,
    messageCount: 0,
    source,
    updatedAt: null,
  };
}
