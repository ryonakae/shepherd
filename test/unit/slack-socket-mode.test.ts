import { describe, expect, test } from "vitest";
import type { SlackInboundResult } from "@/platforms/slack/inbound.js";
import {
  createSlackBoltApp,
  type SlackBoltLikeApp,
  SlackSocketModeAdapter,
} from "@/platforms/slack/socket-mode.js";

describe("SlackSocketModeAdapter", () => {
  test("registers a message event handler and forwards inbound results", async () => {
    const app = new FakeSlackApp();
    const handled: unknown[] = [];
    const forwarded: unknown[] = [];
    const result = { createdSession: true } as SlackInboundResult;
    const adapter = new SlackSocketModeAdapter({
      app,
      inbound: {
        async handleMessageEvent(event) {
          handled.push(event);
          return result;
        },
      },
      async onMessage(message) {
        forwarded.push(message);
      },
    });

    adapter.register();
    await app.emitMessage({ text: "hello", type: "message" });

    expect(handled).toEqual([{ text: "hello", type: "message" }]);
    expect(forwarded).toEqual([result]);
  });

  test("starts once and stops the Bolt app when available", async () => {
    const app = new FakeSlackApp();
    const adapter = new SlackSocketModeAdapter({
      app,
      inbound: {
        async handleMessageEvent() {
          return undefined;
        },
      },
    });

    await adapter.start();
    await adapter.start();
    await adapter.stop();

    expect(app.registeredHandlers).toBe(1);
    expect(app.started).toBe(2);
    expect(app.stopped).toBe(1);
  });
});

describe("createSlackBoltApp", () => {
  test("returns a Bolt-like Socket Mode app", () => {
    const app = createSlackBoltApp({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    });

    expect(typeof app.event).toBe("function");
    expect(typeof app.start).toBe("function");
  });
});

class FakeSlackApp implements SlackBoltLikeApp {
  registeredHandlers = 0;
  started = 0;
  stopped = 0;
  #handler: ((args: { event: unknown }) => Promise<void> | void) | undefined;

  event(eventName: "message", handler: (args: { event: unknown }) => Promise<void> | void): void {
    expect(eventName).toBe("message");
    this.registeredHandlers += 1;
    this.#handler = handler;
  }

  async emitMessage(event: unknown): Promise<void> {
    await this.#handler?.({ event });
  }

  async start(): Promise<unknown> {
    this.started += 1;
    return undefined;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}
