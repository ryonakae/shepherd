import { homedir } from "node:os";
import { join } from "node:path";
import { validateHerdrName } from "./naming.js";

export type HerdrCliCommand = {
  args: string[];
  env: Record<string, string>;
};

export function herdrSocketPathForNamedSession(
  name: string,
  configDir = join(homedir(), ".config", "herdr"),
): string {
  validateHerdrName(name);
  return join(configDir, "sessions", name, "herdr.sock");
}

export function herdrCliCommandForNamedSession(name: string, args: string[]): HerdrCliCommand {
  validateHerdrName(name);

  return {
    args: ["--session", name, ...args],
    env: {
      HERDR_SESSION: name,
    },
  };
}
