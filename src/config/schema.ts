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

const codexProviderSchema = Type.Object(
  {
    auth_source: Type.Literal("codex_cli"),
    mode: Type.Literal("app_server"),
    settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    type: Type.Literal("codex_cli"),
  },
  { additionalProperties: false },
);

const apiKeyProviderSchema = Type.Object(
  {
    api_key_env: Type.String({ minLength: 1 }),
    type: Type.Union([
      Type.Literal("openrouter"),
      Type.Literal("openai"),
      Type.Literal("anthropic"),
    ]),
  },
  { additionalProperties: false },
);

export const gatewayProviderSchema = Type.Union([codexProviderSchema, apiKeyProviderSchema]);

const slackPlatformSchema = Type.Object(
  {
    allow_customize: Type.Optional(Type.Boolean()),
    allowed_channels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    allowed_teams: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    allowed_users: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    app_token_env: Type.String({ minLength: 1 }),
    bot_token_env: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const platformsSchema = Type.Object(
  {
    slack: Type.Optional(slackPlatformSchema),
  },
  { additionalProperties: true },
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
        default_provider: Type.String({ minLength: 1 }),
        model: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    platforms: Type.Optional(platformsSchema),
    providers: Type.Record(Type.String({ minLength: 1 }), gatewayProviderSchema, {
      minProperties: 1,
    }),
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

    if (!(config.gateway.default_provider in config.providers)) {
      return {
        errors: [
          {
            instancePath: "/gateway/default_provider",
            keyword: "requiredProvider",
            message: "must reference a configured provider",
            params: { provider: config.gateway.default_provider },
            schemaPath: "#/requiredProvider",
          },
        ],
        ok: false,
      };
    }

    return { ok: true, value: config };
  }

  return { errors: validateShepherdConfig.errors ?? [], ok: false };
}
