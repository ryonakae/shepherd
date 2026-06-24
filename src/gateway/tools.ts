import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { EventStore } from "@/db/event-store.js";

export type LogicalToolContext = {
  sessionId: string;
};

export type LogicalToolDefinition<Input, Output> = {
  description: string;
  execute: (input: Input, context: LogicalToolContext) => Promise<Output> | Output;
  inputSchema: TSchema;
  name: string;
};

export type ToolPolicy = {
  allowedTools: Set<string>;
};

export class LogicalToolRegistry {
  readonly #tools = new Map<string, LogicalToolDefinition<unknown, unknown>>();

  register<Input, Output>(definition: LogicalToolDefinition<Input, Output>): void {
    if (this.#tools.has(definition.name)) {
      throw new Error(`Logical tool already registered: ${definition.name}`);
    }

    this.#tools.set(definition.name, definition as LogicalToolDefinition<unknown, unknown>);
  }

  list(): LogicalToolDefinition<unknown, unknown>[] {
    return [...this.#tools.values()];
  }

  get(name: string): LogicalToolDefinition<unknown, unknown> {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new Error(`Unknown logical tool: ${name}`);
    }

    return tool;
  }
}

export class LogicalToolRunner {
  readonly #events: EventStore;
  readonly #policy: ToolPolicy;
  readonly #registry: LogicalToolRegistry;

  constructor(options: {
    events: EventStore;
    policy: ToolPolicy;
    registry: LogicalToolRegistry;
  }) {
    this.#events = options.events;
    this.#policy = options.policy;
    this.#registry = options.registry;
  }

  list(): LogicalToolDefinition<unknown, unknown>[] {
    return this.#registry.list();
  }

  async run(name: string, input: unknown, context: LogicalToolContext): Promise<unknown> {
    const tool = this.#registry.get(name);

    if (!this.#policy.allowedTools.has(name)) {
      this.#events.appendEvent({
        payload: { name, reason: "tool_not_allowed" },
        sessionId: context.sessionId,
        type: "gateway.tool.denied",
      });
      throw new Error(`Logical tool is not allowed: ${name}`);
    }

    if (!Value.Check(tool.inputSchema, input)) {
      this.#events.appendEvent({
        payload: { input, name, reason: "invalid_input" },
        sessionId: context.sessionId,
        type: "gateway.tool.denied",
      });
      throw new Error(`Invalid input for logical tool: ${name}`);
    }

    const callEvent = this.#events.appendEvent({
      payload: { input, name },
      sessionId: context.sessionId,
      type: "gateway.tool.call",
    });

    try {
      const output = await tool.execute(input, context);
      this.#events.appendEvent({
        payload: { callEventId: callEvent.id, name, output },
        sessionId: context.sessionId,
        type: "gateway.tool.result",
      });
      return output;
    } catch (error) {
      this.#events.appendEvent({
        payload: {
          callEventId: callEvent.id,
          message: error instanceof Error ? error.message : String(error),
          name,
        },
        sessionId: context.sessionId,
        type: "gateway.tool.error",
      });
      throw error;
    }
  }
}
