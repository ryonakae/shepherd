import { type Static, Type } from "@sinclair/typebox";
import { Ajv, type ErrorObject } from "ajv";

export const agentProfileSchema = Type.Object(
  {
    args: Type.Optional(Type.Array(Type.String())),
    command: Type.String({ minLength: 1 }),
    when: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const slackStreamingSchema = Type.Object(
  {
    buffer_threshold_chars: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(Type.String()),
    edit_interval_ms: Type.Optional(Type.Integer({ minimum: 1 })),
    enabled: Type.Optional(Type.Boolean()),
    tool_progress: Type.Optional(
      Type.Union([Type.Literal("off"), Type.Literal("compact"), Type.Literal("verbose")]),
    ),
  },
  { additionalProperties: false },
);

const slackPlatformSchema = Type.Object(
  {
    allow_customize: Type.Optional(Type.Boolean()),
    allowed_channels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    allowed_teams: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    allowed_users: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    app_token_env: Type.String({ minLength: 1 }),
    bot_token_env: Type.String({ minLength: 1 }),
    streaming: Type.Optional(slackStreamingSchema),
    tui_default_channel: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const platformsSchema = Type.Object(
  {
    slack: Type.Optional(slackPlatformSchema),
  },
  { additionalProperties: true },
);

const runtimePathsSchema = Type.Object(
  {
    db_path: Type.Optional(Type.String({ minLength: 1 })),
    log_path: Type.Optional(Type.String({ minLength: 1 })),
    pid_path: Type.Optional(Type.String({ minLength: 1 })),
    socket_path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const shepherdConfigSchema = Type.Object(
  {
    agents: Type.Record(Type.String({ minLength: 1 }), agentProfileSchema, { minProperties: 1 }),
    auxiliary: Type.Optional(
      Type.Object(
        {
          summary: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        },
        { additionalProperties: false },
      ),
    ),
    context: Type.Optional(
      Type.Object(
        {
          allowed_roots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
    ),
    default_agent: Type.String({ minLength: 1 }),
    gateway: Type.Object(
      {
        pi: Type.Optional(
          Type.Object(
            {
              idle_timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
              readiness_timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    platforms: Type.Optional(platformsSchema),
    runtime: Type.Optional(runtimePathsSchema),
  },
  { additionalProperties: false },
);

export type ShepherdConfig = Static<typeof shepherdConfigSchema>;

export type ValidationResult<T> = { ok: true; value: T } | { errors: ErrorObject[]; ok: false };

const ajv = new Ajv({ allErrors: true });
const validateShepherdConfig = ajv.compile<ShepherdConfig>(shepherdConfigSchema);

export function parseShepherdConfig(value: unknown): ValidationResult<ShepherdConfig> {
  if (validateShepherdConfig(value)) {
    const config = value as ShepherdConfig;

    if (!(config.default_agent in config.agents)) {
      return {
        errors: [
          {
            instancePath: "/default_agent",
            keyword: "requiredAgent",
            message: "must reference a configured agent",
            params: { agent: config.default_agent },
            schemaPath: "#/requiredAgent",
          },
        ],
        ok: false,
      };
    }

    const invalidSlackDefaultChannel = invalidSlackTuiDefaultChannel(config);
    if (invalidSlackDefaultChannel) {
      return {
        errors: [
          {
            instancePath: "/platforms/slack/tui_default_channel",
            keyword: "allowedChannel",
            message: "must be included in platforms.slack.allowed_channels",
            params: { channel: invalidSlackDefaultChannel },
            schemaPath: "#/allowedChannel",
          },
        ],
        ok: false,
      };
    }

    return { ok: true, value: config };
  }

  return { errors: validateShepherdConfig.errors ?? [], ok: false };
}

function invalidSlackTuiDefaultChannel(config: ShepherdConfig): string | undefined {
  const slack = config.platforms?.slack;
  if (!slack?.tui_default_channel || !slack.allowed_channels) {
    return undefined;
  }

  return slack.allowed_channels.includes(slack.tui_default_channel)
    ? undefined
    : slack.tui_default_channel;
}
