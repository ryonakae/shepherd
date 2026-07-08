import { describe, expect, test } from "vitest";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

describe("JSON Lines framing", () => {
  test("encodes one JSON value per newline-delimited frame", () => {
    expect(encodeJsonLine({ id: 1, method: "agent.events" })).toBe(
      '{"id":1,"method":"agent.events"}\n',
    );
  });

  test("decodes frames split across chunks", () => {
    const decoder = new JsonLineDecoder();

    expect(decoder.push('{"id":1')).toEqual([]);
    expect(decoder.push('}\n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("flushes a final frame without a trailing newline", () => {
    const decoder = new JsonLineDecoder();

    expect(decoder.push('{"id":1}')).toEqual([]);
    expect(decoder.flush()).toEqual([{ id: 1 }]);
  });
});
