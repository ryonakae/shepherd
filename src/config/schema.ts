import { type Static, Type } from "@sinclair/typebox";
import { Ajv, type ErrorObject } from "ajv";

const runtimePathsSchema = Type.Object(
  {
    db_path: Type.Optional(Type.String({ minLength: 1 })),
    log_path: Type.Optional(Type.String({ minLength: 1 })),
    pid_path: Type.Optional(Type.String({ minLength: 1 })),
    socket_path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const observabilitySchema = Type.Object(
  {
    telemetry: Type.Optional(
      Type.Object(
        {
          max_excerpt_bytes: Type.Optional(Type.Integer({ minimum: 1, default: 4096 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const shepherdConfigSchema = Type.Object(
  {
    observability: Type.Optional(observabilitySchema),
    runtime: Type.Optional(runtimePathsSchema),
  },
  { additionalProperties: false },
);

export type ShepherdConfig = Static<typeof shepherdConfigSchema>;

export type ValidationResult<T> = { ok: true; value: T } | { errors: ErrorObject[]; ok: false };

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const validateShepherdConfig = ajv.compile<ShepherdConfig>(shepherdConfigSchema);

export function parseShepherdConfig(value: unknown): ValidationResult<ShepherdConfig> {
  if (validateShepherdConfig(value)) {
    return { ok: true, value: value as ShepherdConfig };
  }

  return { errors: validateShepherdConfig.errors ?? [], ok: false };
}
