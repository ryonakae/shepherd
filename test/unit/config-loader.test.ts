import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadShepherdConfig } from "@/config/load.js";
import { parseShepherdConfig } from "@/config/schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("Shepherd config loader", () => {
  test("loads a valid MVP YAML config", () => {
    const path = writeTempConfig(`
gateway:
  default_provider: codex
  model: gpt-5.3-codex

providers:
  codex:
    type: codex_cli
    mode: app_server
    auth_source: codex_cli
  openai:
    type: openai
    api_key_env: OPENAI_API_KEY

default_agent: implementer
agents:
  implementer:
    command: codex
    args: []
    when: Use for implementation work.

context:
  allowed_roots:
    - /Users/ryo.nakae/Dev

platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allow_customize: true
    allowed_teams:
      - T123
    allowed_users:
      - U123
`);

    const result = loadShepherdConfig(path);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.gateway.default_provider).toBe("codex");
      expect(result.value.providers.openai?.type).toBe("openai");
      if (result.value.providers.openai?.type === "openai") {
        expect(result.value.providers.openai.api_key_env).toBe("OPENAI_API_KEY");
      }
      expect(result.value.platforms?.slack?.bot_token_env).toBe("SLACK_BOT_TOKEN");
    }
  });

  test("rejects API key literals in provider config", () => {
    const result = parseShepherdConfig({
      agents: {
        implementer: {
          command: "codex",
        },
      },
      default_agent: "implementer",
      gateway: {
        default_provider: "openai",
        model: "gpt-5.3",
      },
      providers: {
        openai: {
          api_key: "sk-secret",
          type: "openai",
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  test("rejects a default gateway provider that is not configured", () => {
    const result = parseShepherdConfig({
      agents: {
        implementer: {
          command: "codex",
        },
      },
      default_agent: "implementer",
      gateway: {
        default_provider: "codex",
        model: "gpt-5.3-codex",
      },
      providers: {
        openai: {
          api_key_env: "OPENAI_API_KEY",
          type: "openai",
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  test("returns YAML parse errors without throwing", () => {
    const path = writeTempConfig("gateway: [");

    const result = loadShepherdConfig(path);

    expect(result.ok).toBe(false);
  });
});

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-config-"));
  tempDirs.push(dir);

  const path = join(dir, "shepherd.yaml");
  writeFileSync(path, contents);

  return path;
}
