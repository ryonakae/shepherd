import { setTimeout as delay } from "node:timers/promises";
import type { HerdrEventSource } from "./progress.js";

export type HerdrProgressReceiverInput = {
  herdrSessionName: string;
  rawEvent: unknown;
  sessionId: string;
  workspaceId?: string;
};

export type HerdrProgressSubscriptionInput = {
  herdrSessionName: string;
  sessionId: string;
  workspaceId: string;
};

export type HerdrProgressSubscriptionManagerOptions = {
  onError?: (error: unknown, subscription: HerdrProgressSubscriptionInput) => void;
  pollTimeoutMs?: number;
  receiveProgress(input: HerdrProgressReceiverInput): Promise<unknown>;
  retryDelayMs?: number;
  sourceForSession(herdrSessionName: string): HerdrEventSource;
};

type ActiveSubscription = {
  controller: AbortController;
};

export class HerdrProgressSubscriptionManager {
  readonly #active = new Map<string, ActiveSubscription>();
  readonly #onError:
    | ((error: unknown, subscription: HerdrProgressSubscriptionInput) => void)
    | undefined;
  readonly #pollTimeoutMs: number;
  readonly #receiveProgress: (input: HerdrProgressReceiverInput) => Promise<unknown>;
  readonly #retryDelayMs: number;
  readonly #sourceForSession: (herdrSessionName: string) => HerdrEventSource;

  constructor(options: HerdrProgressSubscriptionManagerOptions) {
    this.#onError = options.onError;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
    this.#receiveProgress = options.receiveProgress;
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
    this.#sourceForSession = options.sourceForSession;
  }

  close(): void {
    for (const subscription of this.#active.values()) {
      subscription.controller.abort();
    }
    this.#active.clear();
  }

  subscribe(input: HerdrProgressSubscriptionInput): boolean {
    const key = subscriptionKey(input);
    if (this.#active.has(key)) {
      return false;
    }

    const controller = new AbortController();
    this.#active.set(key, { controller });
    const source = this.#sourceForSession(input.herdrSessionName);
    void this.#run(input, source, controller.signal).finally(() => {
      if (this.#active.get(key)?.controller === controller) {
        this.#active.delete(key);
      }
    });

    return true;
  }

  get size(): number {
    return this.#active.size;
  }

  async #run(
    input: HerdrProgressSubscriptionInput,
    source: HerdrEventSource,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const rawEvent = await source.waitForEvent({
          timeout_ms: this.#pollTimeoutMs,
          workspace_id: input.workspaceId,
        });
        if (signal.aborted) {
          break;
        }
        await this.#receiveProgress({
          herdrSessionName: input.herdrSessionName,
          rawEvent,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
        });
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        this.#onError?.(error, input);
        await delay(this.#retryDelayMs, undefined, { signal }).catch(() => undefined);
      }
    }
  }
}

function subscriptionKey(input: HerdrProgressSubscriptionInput): string {
  return `${input.sessionId}:${input.herdrSessionName}:${input.workspaceId}`;
}
