import type { LanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import {
  type CodexAppServerFactory,
  createCodexAppServerGatewayProvider,
} from "@/gateway/codex-provider.js";

describe("createCodexAppServerGatewayProvider", () => {
  test("wraps the Codex app-server provider with Shepherd defaults", async () => {
    const calls: unknown[] = [];
    const closeCalls: string[] = [];
    const factory: CodexAppServerFactory = (options) => {
      calls.push({ factoryOptions: options });
      const provider = (modelId: string, settings?: unknown) => {
        calls.push({ modelId, settings });
        return "codex-model" as unknown as LanguageModel;
      };

      provider.close = async () => {
        closeCalls.push("close");
      };

      return provider;
    };

    const provider = createCodexAppServerGatewayProvider({
      createProvider: factory,
      model: "gpt-5.3-codex",
      system: "Gateway instructions",
    });

    await provider.close();

    expect(closeCalls).toEqual(["close"]);
    expect(calls).toEqual([
      {
        factoryOptions: {
          defaultSettings: {
            autoApprove: false,
            minCodexVersion: "0.130.0",
            personality: "pragmatic",
          },
        },
      },
      {
        modelId: "gpt-5.3-codex",
        settings: undefined,
      },
    ]);
  });
});
