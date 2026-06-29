import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
  label?: string;
  name: string;
  promptGuidelines?: string[];
  promptSnippet?: string;
};

export type ToolPolicy = {
  allowedTools: Set<string>;
};

export type LogicalToolCallStatus = "completed" | "failed" | "pending" | "running";

export type LogicalToolCallRecord = {
  completedAt: Date | null;
  createdAt: Date;
  id: string;
  idempotencyKey: string;
  input: unknown;
  result: unknown;
  sessionId: string;
  status: LogicalToolCallStatus;
  toolName: string;
  updatedAt: Date;
};

type LogicalToolCallRow = {
  completed_at: number | null;
  created_at: number;
  id: string;
  idempotency_key: string;
  input_json: string;
  result_json: string | null;
  session_id: string;
  status: LogicalToolCallStatus;
  tool_name: string;
  updated_at: number;
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

export class LogicalToolCallStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  begin(input: {
    idempotencyKey: string;
    input: unknown;
    sessionId: string;
    toolName: string;
  }): LogicalToolCallRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `insert or ignore into logical_tool_calls
          (id, session_id, tool_name, idempotency_key, input_json, status, result_json, completed_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'pending', null, null, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.sessionId,
        input.toolName,
        input.idempotencyKey,
        JSON.stringify(input.input),
        now,
        now,
      );

    return this.getByIdempotencyKey(input.sessionId, input.idempotencyKey);
  }

  getByIdempotencyKey(sessionId: string, idempotencyKey: string): LogicalToolCallRecord {
    const row = this.#sqlite
      .prepare("select * from logical_tool_calls where session_id = ? and idempotency_key = ?")
      .get(sessionId, idempotencyKey) as LogicalToolCallRow | undefined;

    if (!row) {
      throw new Error(`Logical tool call not found for idempotency key: ${idempotencyKey}`);
    }

    return mapLogicalToolCall(row);
  }

  markRunning(id: string): LogicalToolCallRecord {
    const now = Date.now();
    this.#sqlite
      .prepare("update logical_tool_calls set status = 'running', updated_at = ? where id = ?")
      .run(now, id);

    return this.getById(id);
  }

  markCompleted(id: string, result: unknown): LogicalToolCallRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update logical_tool_calls set status = 'completed', result_json = ?, completed_at = ?, updated_at = ? where id = ?",
      )
      .run(JSON.stringify(result), now, now, id);

    return this.getById(id);
  }

  markFailed(id: string, error: unknown): LogicalToolCallRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update logical_tool_calls set status = 'failed', result_json = ?, completed_at = ?, updated_at = ? where id = ?",
      )
      .run(
        JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
        now,
        now,
        id,
      );

    return this.getById(id);
  }

  getById(id: string): LogicalToolCallRecord {
    const row = this.#sqlite.prepare("select * from logical_tool_calls where id = ?").get(id) as
      | LogicalToolCallRow
      | undefined;

    if (!row) {
      throw new Error(`Logical tool call not found: ${id}`);
    }

    return mapLogicalToolCall(row);
  }
}

export class LogicalToolRunner {
  readonly #events: EventStore;
  readonly #policy: ToolPolicy;
  readonly #registry: LogicalToolRegistry;
  readonly #toolCalls: LogicalToolCallStore | undefined;

  constructor(options: {
    events: EventStore;
    policy: ToolPolicy;
    registry: LogicalToolRegistry;
    toolCalls?: LogicalToolCallStore;
  }) {
    this.#events = options.events;
    this.#policy = options.policy;
    this.#registry = options.registry;
    this.#toolCalls = options.toolCalls;
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

    const idempotencyKey = inputIdempotencyKey(input);
    const priorCall =
      idempotencyKey && this.#toolCalls
        ? this.#toolCalls.begin({
            idempotencyKey,
            input,
            sessionId: context.sessionId,
            toolName: name,
          })
        : undefined;

    if (priorCall?.status === "completed") {
      this.#events.appendEvent({
        payload: { idempotencyKey, name, reused: true },
        sessionId: context.sessionId,
        type: "gateway.tool.result",
      });
      return priorCall.result;
    }

    if (priorCall && priorCall.status !== "pending") {
      this.#events.appendEvent({
        payload: { idempotencyKey, name, reason: `idempotent_call_${priorCall.status}` },
        sessionId: context.sessionId,
        type: "gateway.tool.denied",
      });
      throw new Error(
        `Logical tool idempotency key is already ${priorCall.status}: ${idempotencyKey}`,
      );
    }

    const callRecord = priorCall ? this.#toolCalls?.markRunning(priorCall.id) : undefined;
    const callEvent = this.#events.appendEvent({
      payload: { idempotencyKey, input, name },
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
      if (callRecord && this.#toolCalls) {
        this.#toolCalls.markCompleted(callRecord.id, output);
      }
      return output;
    } catch (error) {
      if (callRecord && this.#toolCalls) {
        this.#toolCalls.markFailed(callRecord.id, error);
      }
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

function inputIdempotencyKey(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const idempotencyKey = (input as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof idempotencyKey === "string" && idempotencyKey.length > 0
    ? idempotencyKey
    : undefined;
}

function mapLogicalToolCall(row: LogicalToolCallRow): LogicalToolCallRecord {
  return {
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
    createdAt: new Date(row.created_at),
    id: row.id,
    idempotencyKey: row.idempotency_key,
    input: JSON.parse(row.input_json),
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    sessionId: row.session_id,
    status: row.status,
    toolName: row.tool_name,
    updatedAt: new Date(row.updated_at),
  };
}
