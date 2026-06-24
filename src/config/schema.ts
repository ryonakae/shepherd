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

export const shepherdConfigSchema = Type.Object(
  {
    agents: Type.Record(Type.String({ minLength: 1 }), agentProfileSchema, { minProperties: 1 }),
    default_agent: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
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

    return { ok: true, value: config };
  }

  return { errors: validateShepherdConfig.errors ?? [], ok: false };
}
