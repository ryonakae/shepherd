import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { parseShepherdConfig, type ShepherdConfig } from "./schema.js";

export type ConfigLoadError = {
  message: string;
  path?: string;
};

export type ConfigLoadResult =
  | { ok: true; value: ShepherdConfig }
  | { errors: ConfigLoadError[]; ok: false };

export function loadShepherdConfig(path: string): ConfigLoadResult {
  const source = readFileSync(path, "utf8");
  const document = parseDocument(source);

  if (document.errors.length > 0) {
    return {
      errors: document.errors.map((error) => ({
        message: error.message,
        path,
      })),
      ok: false,
    };
  }

  const result = parseShepherdConfig(document.toJSON());
  if (result.ok) {
    return result;
  }

  return {
    errors: result.errors.map((error) => ({
      message: error.message ?? `${error.instancePath} failed ${error.keyword}`,
      path,
    })),
    ok: false,
  };
}
