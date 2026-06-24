import type { HerdrControlClient } from "./orchestrator.js";
import { HerdrSessionLifecycle } from "./session-lifecycle.js";
import { HerdrSocketClient } from "./socket-client.js";

export type ManagedHerdrSocketClientOptions = {
  herdrSessionName: string;
  lifecycle?: HerdrSessionLifecycle;
};

export class ManagedHerdrSocketClient implements HerdrControlClient {
  readonly #herdrSessionName: string;
  readonly #lifecycle: HerdrSessionLifecycle;
  #client: HerdrSocketClient | undefined;
  #clientPromise: Promise<HerdrSocketClient> | undefined;

  constructor(options: ManagedHerdrSocketClientOptions) {
    this.#herdrSessionName = options.herdrSessionName;
    this.#lifecycle = options.lifecycle ?? new HerdrSessionLifecycle();
  }

  close(): void {
    this.#client?.close();
    this.#client = undefined;
    this.#clientPromise = undefined;
  }

  async createWorkspace(params: { cwd: string; label: string }): Promise<unknown> {
    return (await this.#getClient()).createWorkspace(params);
  }

  async createTab(params: { label: string; workspace_id?: string }): Promise<unknown> {
    return (await this.#getClient()).createTab(params);
  }

  async splitPane(params: Parameters<HerdrSocketClient["splitPane"]>[0]): Promise<unknown> {
    return (await this.#getClient()).splitPane(params);
  }

  async runPaneCommand(
    params: Parameters<HerdrSocketClient["runPaneCommand"]>[0],
  ): Promise<unknown> {
    return (await this.#getClient()).runPaneCommand(params);
  }

  async readPane(params: Parameters<HerdrSocketClient["readPane"]>[0]): Promise<unknown> {
    return (await this.#getClient()).readPane(params);
  }

  async readAgent(params: Parameters<HerdrSocketClient["readAgent"]>[0]): Promise<unknown> {
    return (await this.#getClient()).readAgent(params);
  }

  async sendAgentMessage(
    params: Parameters<HerdrSocketClient["sendAgentMessage"]>[0],
  ): Promise<unknown> {
    return (await this.#getClient()).sendAgentMessage(params);
  }

  async startAgent(params: Parameters<HerdrSocketClient["startAgent"]>[0]): Promise<unknown> {
    return (await this.#getClient()).startAgent(params);
  }

  async waitForAgent(params: Parameters<HerdrSocketClient["waitForAgent"]>[0]): Promise<unknown> {
    return (await this.#getClient()).waitForAgent(params);
  }

  async waitForOutput(params: Parameters<HerdrSocketClient["waitForOutput"]>[0]): Promise<unknown> {
    return (await this.#getClient()).waitForOutput(params);
  }

  async #getClient(): Promise<HerdrSocketClient> {
    if (this.#client) {
      return this.#client;
    }

    this.#clientPromise ??= this.#connect();
    return this.#clientPromise;
  }

  async #connect(): Promise<HerdrSocketClient> {
    const { socketPath } = await this.#lifecycle.ensureNamedSession(this.#herdrSessionName);
    const client = new HerdrSocketClient({ socketPath });
    this.#client = client;
    return client;
  }
}
