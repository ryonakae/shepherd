import { App } from "@slack/bolt";
import type { SlackInboundHandler, SlackInboundResult } from "./inbound.js";

export type SlackBoltLikeApp = {
  event(eventName: "message", handler: (args: { event: unknown }) => Promise<void> | void): void;
  start(): Promise<unknown>;
  stop?: () => Promise<void>;
};

export type SlackSocketModeAdapterOptions = {
  app: SlackBoltLikeApp;
  inbound: Pick<SlackInboundHandler, "handleMessageEvent">;
  onMessage?: (result: SlackInboundResult) => Promise<void> | void;
};

export class SlackSocketModeAdapter {
  readonly #app: SlackBoltLikeApp;
  readonly #inbound: Pick<SlackInboundHandler, "handleMessageEvent">;
  readonly #onMessage: ((result: SlackInboundResult) => Promise<void> | void) | undefined;
  #registered = false;

  constructor(options: SlackSocketModeAdapterOptions) {
    this.#app = options.app;
    this.#inbound = options.inbound;
    this.#onMessage = options.onMessage;
  }

  register(): void {
    if (this.#registered) {
      return;
    }

    this.#app.event("message", async ({ event }) => {
      const result = this.#inbound.handleMessageEvent(event);
      if (result) {
        await this.#onMessage?.(result);
      }
    });
    this.#registered = true;
  }

  async start(): Promise<void> {
    this.register();
    await this.#app.start();
  }

  async stop(): Promise<void> {
    await this.#app.stop?.();
  }
}

export function createSlackBoltApp(options: {
  appToken: string;
  botToken: string;
}): SlackBoltLikeApp {
  return new App({
    appToken: options.appToken,
    socketMode: true,
    token: options.botToken,
  }) as SlackBoltLikeApp;
}
