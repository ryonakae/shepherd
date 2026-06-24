import { describe, expect, test } from "vitest";
import { herdrCliCommandForNamedSession, herdrSocketPathForNamedSession } from "@/herdr/session.js";

describe("Herdr session helpers", () => {
  test("resolves the named-session socket path", () => {
    expect(herdrSocketPathForNamedSession("shepherd-api", "/config/herdr")).toBe(
      "/config/herdr/sessions/shepherd-api/herdr.sock",
    );
  });

  test("builds CLI commands scoped to a named session", () => {
    expect(herdrCliCommandForNamedSession("shepherd-api", ["workspace", "list"])).toEqual({
      args: ["--session", "shepherd-api", "workspace", "list"],
      env: {
        HERDR_SESSION: "shepherd-api",
      },
    });
  });

  test("rejects invalid session names before calling Herdr", () => {
    expect(() => herdrSocketPathForNamedSession("bad/session", "/config/herdr")).toThrow(
      "Invalid Herdr name",
    );
  });
});
