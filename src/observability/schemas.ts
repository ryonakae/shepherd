import { Type } from "@sinclair/typebox";

export const agentSessionRefSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
    source: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const agentListInputSchema = Type.Object(
  {
    all: Type.Optional(Type.Boolean()),
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentGetInputSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    target: Type.String({ minLength: 1 }),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentReadInputSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    target: Type.String({ minLength: 1 }),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentEventsInputSchema = Type.Object(
  {
    afterEventId: Type.Optional(Type.Integer({ minimum: 0 })),
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentNotificationSubscribeInputSchema = Type.Object(
  {
    autoResume: Type.Optional(Type.Boolean()),
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    subscriberId: Type.String({ minLength: 1 }),
    subscriberKind: Type.String({ minLength: 1 }),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentNotificationAckInputSchema = Type.Object(
  {
    eventId: Type.Integer({ minimum: 1 }),
    subscriptionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const agentToolTelemetryEventSchema = Type.Object(
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
    type: Type.Literal("agent.tool.completed"),
  },
  { additionalProperties: false },
);

const agentMessageFinalTelemetryEventSchema = Type.Object(
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
    type: Type.Literal("agent.message.final"),
  },
  { additionalProperties: false },
);

export const agentTelemetryInputSchema = Type.Object(
  {
    event: Type.Union([agentToolTelemetryEventSchema, agentMessageFinalTelemetryEventSchema]),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
