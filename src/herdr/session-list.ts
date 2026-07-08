import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type HerdrSessionListEntry = {
  default?: boolean;
  name: string;
  running: boolean;
  sessionDir: string;
  socketPath: string;
};

export type HerdrSessionListRunner = () => Promise<HerdrSessionListEntry[]>;

export function createHerdrSessionListRunner(
  options: { command?: string; env?: NodeJS.ProcessEnv } = {},
): HerdrSessionListRunner {
  const command = options.command ?? "herdr";
  return async () => {
    const { stdout } = await execFileAsync(command, ["session", "list", "--json"], {
      env: options.env ?? process.env,
      encoding: "utf8",
    });
    return normalizeHerdrSessionList(stdout);
  };
}

export function normalizeHerdrSessionList(value: string | unknown): HerdrSessionListEntry[] {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(
      `Failed to parse herdr session list --json output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  return sessions.map((session) => {
    const item =
      typeof session === "object" && session !== null ? (session as Record<string, unknown>) : {};
    const name = stringValue(item.name);
    const sessionDir = stringValue(item.session_dir) ?? stringValue(item.sessionDir);
    const socketPath = stringValue(item.socket_path) ?? stringValue(item.socketPath);
    if (!name || !sessionDir || !socketPath) {
      throw new Error("Invalid herdr session list entry");
    }
    return {
      ...(typeof item.default === "boolean" ? { default: item.default } : {}),
      name,
      running: item.running === true,
      sessionDir,
      socketPath,
    };
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
