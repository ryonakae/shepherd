import { describe, expect, test } from "vitest";

const extensionModuleUrl = new URL("../../packages/shepherd-pi/src/index.ts", import.meta.url).href;

type CompletionItem = {
  description?: string;
  label: string;
  value: string;
};

type CommandOptions = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => CompletionItem[] | null;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};

type AutocompleteProvider = {
  applyCompletion: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: CompletionItem,
    prefix: string,
  ) => { cursorCol: number; cursorLine: number; lines: string[] };
  getSuggestions: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { force?: boolean; signal: AbortSignal },
  ) => Promise<{ items: CompletionItem[]; prefix: string } | null>;
  shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number) => boolean;
};

type ShepherdPiExtensionModule = {
  completeShepherdCommandArguments: NonNullable<CommandOptions["getArgumentCompletions"]>;
  createShepherdAutocompleteProvider: (current: AutocompleteProvider) => AutocompleteProvider;
  default: (pi: {
    on: (eventName: string, handler: unknown) => void;
    registerCommand: (name: string, options: CommandOptions) => void;
  }) => void;
  shepherdCommandArgumentPrefix: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ) => string | undefined;
};

describe("shepherd-pi extension command completions", () => {
  test("suggests /shepherd subcommands after a space", async () => {
    const { completeShepherdCommandArguments } = (await import(
      extensionModuleUrl
    )) as ShepherdPiExtensionModule;

    expect(completeShepherdCommandArguments("")).toEqual([
      expect.objectContaining({ label: "attach", value: "attach " }),
      expect.objectContaining({ label: "rename", value: "rename " }),
      expect.objectContaining({ label: "status", value: "status" }),
      expect.objectContaining({ label: "detach", value: "detach" }),
    ]);
    expect(completeShepherdCommandArguments("re")).toEqual([
      expect.objectContaining({ label: "rename", value: "rename " }),
    ]);
    expect(completeShepherdCommandArguments("attach session-1")).toBeNull();
  });

  test("provides Shepherd argument completions through an autocomplete provider", async () => {
    const { createShepherdAutocompleteProvider, shepherdCommandArgumentPrefix } = (await import(
      extensionModuleUrl
    )) as ShepherdPiExtensionModule;
    const current = fakeAutocompleteProvider();
    const provider = createShepherdAutocompleteProvider(current);
    const signal = new AbortController().signal;

    expect(shepherdCommandArgumentPrefix(["/shepherd "], 0, "/shepherd ".length)).toBe("");
    await expect(
      provider.getSuggestions(["/shepherd "], 0, "/shepherd ".length, { force: true, signal }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ label: "attach", value: "attach " }),
        expect.objectContaining({ label: "rename", value: "rename " }),
        expect.objectContaining({ label: "status", value: "status" }),
        expect.objectContaining({ label: "detach", value: "detach" }),
      ],
      prefix: "",
    });
    await expect(
      provider.getSuggestions(["/shepherd re"], 0, "/shepherd re".length, { signal }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ label: "rename", value: "rename " })],
      prefix: "re",
    });
    expect(provider.shouldTriggerFileCompletion?.(["/shepherd "], 0, "/shepherd ".length)).toBe(
      true,
    );
    await expect(
      provider.getSuggestions(["hello"], 0, "hello".length, { signal }),
    ).resolves.toEqual({
      items: [{ label: "fallback", value: "fallback" }],
      prefix: "fallback",
    });
  });

  test("registers /shepherd with argument completions", async () => {
    const registeredCommands = new Map<string, CommandOptions>();
    const { default: shepherdPiExtension, completeShepherdCommandArguments } = (await import(
      extensionModuleUrl
    )) as ShepherdPiExtensionModule;

    shepherdPiExtension({
      on() {},
      registerCommand(name, options) {
        registeredCommands.set(name, options);
      },
    });

    expect(registeredCommands.get("shepherd")?.getArgumentCompletions).toBe(
      completeShepherdCommandArguments,
    );
  });
});

function fakeAutocompleteProvider(): AutocompleteProvider {
  return {
    applyCompletion(lines, cursorLine, cursorCol) {
      return { cursorCol, cursorLine, lines };
    },
    async getSuggestions() {
      return {
        items: [{ label: "fallback", value: "fallback" }],
        prefix: "fallback",
      };
    },
    shouldTriggerFileCompletion() {
      return false;
    },
  };
}
