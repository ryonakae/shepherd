import { stat } from "node:fs/promises";
import type { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import type {
  AgentHistoryMessage,
  AgentHistoryRef,
  AgentHistorySourceFingerprint,
  CompactAgentHistory,
} from "@/observability/contracts.js";
import { ClaudeHistoryReader } from "./claude-reader.js";
import { CodexHistoryReader } from "./codex-reader.js";
import { type AgentHistoryLookupInput, discoverAgentHistory } from "./discovery.js";
import { GeminiHistoryReader } from "./gemini-reader.js";
import { OpenCodeHistoryReader } from "./opencode-reader.js";
import { PiHistoryReader } from "./pi-reader.js";
import type { AgentHistoryReader } from "./readers.js";

export const agentHistoryFormatterVersion = "agent-history-v1";

type CacheLike = Pick<AgentHistoryCacheStore, "getFresh" | "put">;
type Discovery = (input: AgentHistoryLookupInput) => Promise<AgentHistoryRef | null>;

export type ResolvedCompactAgentHistory = {
  compactHistory: CompactAgentHistory;
  historyRef: AgentHistoryRef | null;
  sourceFingerprint: AgentHistorySourceFingerprint | null;
};

export function createAgentHistoryService(
  options: {
    cache?: CacheLike;
    discover?: Discovery;
    homeDir?: string;
    readers?: AgentHistoryReader[];
  } = {},
) {
  const readers = options.readers ?? [
    new PiHistoryReader(),
    new ClaudeHistoryReader(),
    new CodexHistoryReader(),
    new OpenCodeHistoryReader(),
    new GeminiHistoryReader(),
  ];
  const discover: Discovery =
    options.discover ??
    ((input) =>
      discoverAgentHistory({
        ...input,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      }));

  async function readCompactRef(historyRef: AgentHistoryRef): Promise<ResolvedCompactAgentHistory> {
    const reader = readers.find((candidate) => candidate.canRead(historyRef));
    if (!reader) return unresolvedCompactHistory(historyRef.source);

    const path = historyRef.path ?? historyRef.value;
    const stats = await stat(path).catch(() => null);
    if (!stats) return unresolvedCompactHistory(historyRef.source);

    const sourceFingerprint = {
      mtimeMs: Math.trunc(stats.mtimeMs),
      path,
      size: stats.size,
    };
    const cacheSourcePath = cacheSourcePathForRef(historyRef);
    const cached = options.cache?.getFresh({
      formatterVersion: agentHistoryFormatterVersion,
      sourceMtimeMs: sourceFingerprint.mtimeMs,
      sourcePath: cacheSourcePath,
      sourceSize: sourceFingerprint.size,
    });
    if (cached) {
      return { compactHistory: cached.compactHistory, historyRef, sourceFingerprint };
    }

    try {
      const compactHistory = await reader.readCompact(historyRef);
      options.cache?.put({
        compactHistory,
        formatterVersion: agentHistoryFormatterVersion,
        historyRef,
        sourceMtimeMs: sourceFingerprint.mtimeMs,
        sourcePath: cacheSourcePath,
        sourceSize: sourceFingerprint.size,
      });
      return { compactHistory, historyRef, sourceFingerprint };
    } catch {
      return unresolvedCompactHistory(historyRef.source);
    }
  }

  async function resolveCompactHistory(
    input: AgentHistoryLookupInput,
    resolveOptions: { forceDiscovery?: boolean; preferredRef?: AgentHistoryRef | null } = {},
  ): Promise<ResolvedCompactAgentHistory> {
    if (resolveOptions.preferredRef && !resolveOptions.forceDiscovery) {
      const preferred = await readCompactRef(resolveOptions.preferredRef);
      if (preferred.historyRef) return preferred;
    }
    const historyRef = await discover(input);
    if (!historyRef) return unresolvedCompactHistory();
    return readCompactRef(historyRef);
  }

  async function readRef(
    historyRef: AgentHistoryRef,
    readOptions: { limit: number },
  ): Promise<{ historyRef: AgentHistoryRef | null; messages: AgentHistoryMessage[] }> {
    const reader = readers.find((candidate) => candidate.canRead(historyRef));
    const path = historyRef.path ?? historyRef.value;
    if (!reader || !(await stat(path).catch(() => null))) return { historyRef: null, messages: [] };
    try {
      return { historyRef, messages: await reader.read(historyRef, readOptions) };
    } catch {
      return { historyRef: null, messages: [] };
    }
  }

  return {
    discover,
    getCompactHistory: async (input: AgentHistoryLookupInput): Promise<CompactAgentHistory> =>
      (await resolveCompactHistory(input)).compactHistory,
    readCompactRef,
    resolveCompactHistory,
    async read(
      input: AgentHistoryLookupInput,
      readOptions: { limit: number; preferredRef?: AgentHistoryRef | null },
    ): Promise<{ historyRef: AgentHistoryRef | null; messages: AgentHistoryMessage[] }> {
      if (readOptions.preferredRef) {
        const preferred = await readRef(readOptions.preferredRef, readOptions);
        if (preferred.historyRef) return preferred;
      }
      const historyRef = await discover(input);
      if (!historyRef) return { historyRef: null, messages: [] };
      return readRef(historyRef, readOptions);
    },
  };
}

function unresolvedCompactHistory(source: string | null = null): ResolvedCompactAgentHistory {
  return {
    compactHistory: emptyCompactHistory(source),
    historyRef: null,
    sourceFingerprint: null,
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
