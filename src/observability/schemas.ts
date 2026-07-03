import { Type } from "@sinclair/typebox";

const agentSessionRefSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
    source: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const observeWorkspaceBySessionSchema = Type.Object(
  {
    herdrSessionName: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String({ minLength: 1 })),
    socketPath: Type.Optional(Type.String({ minLength: 1 })),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const observeWorkspaceBySocketSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    label: Type.Optional(Type.String({ minLength: 1 })),
    socketPath: Type.String({ minLength: 1 }),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const observeWorkspaceInputSchema = Type.Union([
  observeWorkspaceBySessionSchema,
  observeWorkspaceBySocketSchema,
]);

const workerToolTelemetryEventSchema = Type.Object(
  {
    artifactRefs: Type.Array(Type.String()),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    errorExcerpt: Type.Optional(Type.String({ maxLength: 4096 })),
    inputPreview: Type.Optional(Type.String({ maxLength: 4096 })),
    isError: Type.Boolean(),
    occurredAt: Type.String({ minLength: 1 }),
    outputExcerpt: Type.Optional(Type.String({ maxLength: 4096 })),
    redactionApplied: Type.Boolean(),
    runtime: Type.String({ minLength: 1 }),
    sessionRef: Type.Union([agentSessionRefSchema, Type.Null()]),
    toolCallId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    turnId: Type.String({ minLength: 1 }),
    type: Type.Literal("worker.tool.completed"),
    workerKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const workerMessageFinalTelemetryEventSchema = Type.Object(
  {
    blockedHint: Type.Optional(Type.String({ maxLength: 4096 })),
    completionHint: Type.Optional(Type.String({ maxLength: 4096 })),
    evidenceRefs: Type.Array(Type.String()),
    needsInputHint: Type.Optional(Type.String({ maxLength: 4096 })),
    occurredAt: Type.String({ minLength: 1 }),
    redactionApplied: Type.Boolean(),
    runtime: Type.String({ minLength: 1 }),
    sessionRef: Type.Union([agentSessionRefSchema, Type.Null()]),
    stopReason: Type.String({ minLength: 1 }),
    textExcerpt: Type.String({ maxLength: 4096 }),
    turnId: Type.String({ minLength: 1 }),
    type: Type.Literal("worker.message.final"),
    workerKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const workerLifecycleTelemetryEventSchema = Type.Object(
  {
    occurredAt: Type.String({ minLength: 1 }),
    runtime: Type.String({ minLength: 1 }),
    sessionRef: Type.Union([agentSessionRefSchema, Type.Null()]),
    status: Type.Union([
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("idle"),
      Type.Literal("unknown"),
      Type.Literal("working"),
    ]),
    type: Type.Literal("worker.lifecycle"),
    workerKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const runtimeTelemetryInputSchema = Type.Object(
  {
    event: Type.Union([
      workerToolTelemetryEventSchema,
      workerMessageFinalTelemetryEventSchema,
      workerLifecycleTelemetryEventSchema,
    ]),
    observedWorkspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const workspaceSnapshotInputSchema = Type.Object(
  { observedWorkspaceId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const workerEventsInputSchema = Type.Object(
  {
    afterEventId: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    observedWorkspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const workerMessageInputSchema = Type.Object(
  {
    text: Type.String({ minLength: 1 }),
    workerId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const workerWaitStateInputSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("idle"),
      Type.Literal("unknown"),
      Type.Literal("working"),
    ]),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    workerId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const workerStartInputSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
    name: Type.String({ minLength: 1 }),
    observedWorkspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const notificationSubscribeInputSchema = Type.Object(
  {
    autoResume: Type.Optional(Type.Boolean()),
    observedWorkspaceId: Type.String({ minLength: 1 }),
    subscriberId: Type.String({ minLength: 1 }),
    subscriberKind: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const notificationAckInputSchema = Type.Object(
  {
    eventId: Type.Integer({ minimum: 1 }),
    subscriptionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
