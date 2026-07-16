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

const piPresenceSessionRefSchema = Type.Object(
  {
    agent: Type.Literal("pi"),
    kind: Type.Literal("path"),
    source: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const agentOrchestratorRegisterInputSchema = Type.Object(
  {
    herdrSocketPath: Type.String({ minLength: 1 }),
    paneId: Type.String({ minLength: 1 }),
    sessionRef: piPresenceSessionRefSchema,
    subscriberId: Type.String({ minLength: 1 }),
    subscriberKind: Type.Literal("pi"),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const agentOrchestratorSetInputSchema = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false },
);

export const agentOrchestratorGetInputSchema = Type.Object({}, { additionalProperties: false });

export const agentOrchestratorAckInputSchema = Type.Object(
  { eventId: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
