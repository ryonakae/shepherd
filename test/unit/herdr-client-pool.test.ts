import { describe, expect, test } from "vitest";
import { HerdrClientPool } from "@/herdr/client-pool.js";

describe("HerdrClientPool", () => {
  test("caches clients by Herdr session name and closes all clients", () => {
    const created: string[] = [];
    const closed: string[] = [];
    const pool = new HerdrClientPool({
      createClient(sessionName) {
        created.push(sessionName);
        return {
          close() {
            closed.push(sessionName);
          },
        };
      },
    });

    expect(pool.get("shepherd-api")).toBe(pool.get("shepherd-api"));
    expect(pool.get("shepherd-docs")).not.toBe(pool.get("shepherd-api"));

    pool.closeAll();

    expect(created).toEqual(["shepherd-api", "shepherd-docs"]);
    expect(closed).toEqual(["shepherd-api", "shepherd-docs"]);
  });
});
