import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentHistoryLookupInput } from "@/agent-history/discovery.js";
import type { AgentHistoryReader } from "@/agent-history/readers.js";
import {
  cacheSourcePathForRef,
  createAgentHistoryService,
  emptyCompactHistory,
} from "@/agent-history/service.js";
import type { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import type { AgentHistoryRef } from "@/observability/contracts.js";

const tempDirs: string[] = [];
const lookup: AgentHistoryLookupInput = {
  agent: "pi",
  agentSession: null,
  cwd: "/repo",
  foregroundCwd: null,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function sourceFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shepherd-history-service-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, "history\\n");
  return path;
}

function ref(path: string, source: AgentHistoryRef["source"] = "pi-jsonl"): AgentHistoryRef {
  return { kind: "discovered_file", path, source, value: path };
}

function reader(input: { failCompact?: boolean; failRead?: boolean } = {}) {
  const compactRefs: AgentHistoryRef[] = [];
  const readRefs: AgentHistoryRef[] = [];
  const fake: AgentHistoryReader = {
    canRead: (historyRef) =>
      historyRef.source === "pi-jsonl" || historyRef.source === "opencode-sqlite",
    async read(historyRef) {
      readRefs.push(historyRef);
      if (input.failRead) throw new Error("read failed");
      return [{ ref: "entry", role: "assistant", text: "done", timestamp: null }];
    },
    async readCompact(historyRef) {
      compactRefs.push(historyRef);
      if (input.failCompact) throw new Error("compact failed");
      return {
        ...emptyCompactHistory(historyRef.source),
        historyRef,
        lastAssistantMessage: { ref: "entry", text: "done", timestamp: null },
      };
    },
  };
  return { compactRefs, fake, readRefs };
}

function service(input: {
  cache?: Pick<AgentHistoryCacheStore, "getFresh" | "put">;
  discovered: AgentHistoryRef | null;
  reader?: ReturnType<typeof reader>;
}) {
  const fakeReader = input.reader ?? reader();
  let discoveries = 0;
  return {
    discoveries: () => discoveries,
    reader: fakeReader,
    service: createAgentHistoryService({
      ...(input.cache ? { cache: input.cache } : {}),
      discover: async () => {
        discoveries += 1;
        return input.discovered;
      },
      readers: [fakeReader.fake],
    }),
  };
}

describe("agent history service", () => {
  test("reads a valid preferred ref without discovery and returns its file fingerprint", async () => {
    const path = await sourceFile("preferred.jsonl");
    const preferred = ref(path);
    const fixture = service({ discovered: null });

    const result = await fixture.service.resolveCompactHistory(lookup, { preferredRef: preferred });

    const stats = await stat(path);
    expect(fixture.discoveries()).toBe(0);
    expect(fixture.reader.compactRefs).toEqual([preferred]);
    expect(result).toMatchObject({
      compactHistory: { historyRef: preferred },
      historyRef: preferred,
      sourceFingerprint: { path, mtimeMs: Math.trunc(stats.mtimeMs), size: stats.size },
    });
  });

  test("returns a fresh cached compact history without reading its preferred ref", async () => {
    const path = await sourceFile("cached.jsonl");
    const preferred = ref(path);
    const cached = { ...emptyCompactHistory("pi-jsonl"), historyRef: preferred, messageCount: 4 };
    const fixture = service({
      cache: {
        getFresh: () => ({ compactHistory: cached }) as never,
        put: () => undefined as never,
      },
      discovered: null,
    });

    const result = await fixture.service.resolveCompactHistory(lookup, { preferredRef: preferred });

    expect(result.compactHistory).toEqual(cached);
    expect(fixture.reader.compactRefs).toEqual([]);
    expect(fixture.discoveries()).toBe(0);
  });

  test("force discovery ignores the preferred ref", async () => {
    const preferred = ref(await sourceFile("preferred.jsonl"));
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const fixture = service({ discovered });

    const result = await fixture.service.resolveCompactHistory(lookup, {
      forceDiscovery: true,
      preferredRef: preferred,
    });

    expect(fixture.discoveries()).toBe(1);
    expect(fixture.reader.compactRefs).toEqual([discovered]);
    expect(result.historyRef).toEqual(discovered);
  });

  test("returns empty history when a direct ref source has disappeared", async () => {
    const fixture = service({ discovered: null });
    const result = await fixture.service.readCompactRef(
      ref(join(tmpdir(), "missing-history.jsonl")),
    );

    expect(result).toEqual({
      compactHistory: emptyCompactHistory("pi-jsonl"),
      historyRef: null,
      sourceFingerprint: null,
    });
  });

  test("uses the OpenCode DB path for fingerprints while preserving the session id", async () => {
    const path = await sourceFile("opencode.db");
    const preferred: AgentHistoryRef = {
      kind: "discovered_file",
      path,
      source: "opencode-sqlite",
      value: "session-a",
    };
    const fixture = service({ discovered: null });

    const result = await fixture.service.readCompactRef(preferred);

    expect(result.historyRef).toEqual(preferred);
    expect(result.sourceFingerprint?.path).toBe(path);
    expect(result.compactHistory.historyRef?.value).toBe("session-a");
  });

  test("uses a preferred ref for live reads and falls back once when it is missing", async () => {
    const preferred = ref(await sourceFile("preferred.jsonl"));
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const fixture = service({ discovered });

    await expect(
      fixture.service.read(lookup, { limit: 1, preferredRef: preferred }),
    ).resolves.toMatchObject({
      historyRef: preferred,
      messages: [expect.objectContaining({ text: "done" })],
    });
    expect(fixture.discoveries()).toBe(0);
    expect(fixture.reader.readRefs).toEqual([preferred]);

    const missing = ref(join(tmpdir(), "missing-history.jsonl"));
    await expect(
      fixture.service.read(lookup, { limit: 1, preferredRef: missing }),
    ).resolves.toMatchObject({
      historyRef: discovered,
    });
    expect(fixture.discoveries()).toBe(1);
    expect(fixture.reader.readRefs).toEqual([preferred, discovered]);
  });

  test("rediscovers exactly once when a preferred ref is missing or its reader fails", async () => {
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const missingFixture = service({ discovered });
    const missing = ref(join(tmpdir(), "missing-history.jsonl"));

    await expect(
      missingFixture.service.resolveCompactHistory(lookup, { preferredRef: missing }),
    ).resolves.toMatchObject({ historyRef: discovered });
    expect(missingFixture.discoveries()).toBe(1);

    const failedReader = reader({ failCompact: true });
    const failedFixture = service({
      discovered,
      reader: failedReader,
    });
    await expect(
      failedFixture.service.resolveCompactHistory(lookup, {
        preferredRef: ref(await sourceFile("bad.jsonl")),
      }),
    ).resolves.toEqual({
      compactHistory: emptyCompactHistory("pi-jsonl"),
      historyRef: null,
      sourceFingerprint: null,
    });
    expect(failedFixture.discoveries()).toBe(1);
    expect(failedReader.compactRefs).toHaveLength(2);
  });

  test("uses the same one-fallback rule for reader failures during live reads", async () => {
    const preferred = ref(await sourceFile("preferred.jsonl"));
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const fixture = service({ discovered, reader: reader({ failRead: true }) });

    await expect(
      fixture.service.read(lookup, { limit: 1, preferredRef: preferred }),
    ).resolves.toEqual({
      historyRef: null,
      messages: [],
    });
    expect(fixture.discoveries()).toBe(1);
    expect(fixture.reader.readRefs).toEqual([preferred, discovered]);
  });

  test("keeps getCompactHistory as the compatibility compact-history wrapper", async () => {
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const fixture = service({ discovered });

    await expect(fixture.service.getCompactHistory(lookup)).resolves.toEqual({
      ...emptyCompactHistory("pi-jsonl"),
      historyRef: discovered,
      lastAssistantMessage: { ref: "entry", text: "done", timestamp: null },
    });
  });

  test("uses session-specific cache keys for OpenCode DB refs", () => {
    const first: AgentHistoryRef = {
      kind: "discovered_file",
      path: "/tmp/opencode.db",
      source: "opencode-sqlite",
      value: "session-a",
    };
    const second: AgentHistoryRef = { ...first, value: "session-b" };

    expect(cacheSourcePathForRef(first)).toBe("/tmp/opencode.db#session=session-a");
    expect(cacheSourcePathForRef(second)).toBe("/tmp/opencode.db#session=session-b");
  });
});
