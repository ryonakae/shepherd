import { HerdrSessionLifecycle } from "./session-lifecycle.js";
import { HerdrSocketClient } from "./socket-client.js";

export type ManagedHerdrSocketClientOptions = {
  herdrSessionName: string;
  lifecycle?: HerdrSessionLifecycle;
};

export class ManagedHerdrSocketClient {
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

  async listWorkspaces(): Promise<unknown> {
    return (await this.#getClient()).listWorkspaces();
  }

  async getWorkspace(params: Parameters<HerdrSocketClient["getWorkspace"]>[0]): Promise<unknown> {
    return (await this.#getClient()).getWorkspace(params);
  }

  async focusWorkspace(
    params: Parameters<HerdrSocketClient["focusWorkspace"]>[0],
  ): Promise<unknown> {
    return (await this.#getClient()).focusWorkspace(params);
  }

  async createTab(params: { label: string; workspace_id?: string }): Promise<unknown> {
    return (await this.#getClient()).createTab(params);
  }

  async listTabs(params: Parameters<HerdrSocketClient["listTabs"]>[0] = {}): Promise<unknown> {
    return (await this.#getClient()).listTabs(params);
  }

  async getTab(params: Parameters<HerdrSocketClient["getTab"]>[0]): Promise<unknown> {
    return (await this.#getClient()).getTab(params);
  }

  async splitPane(params: Parameters<HerdrSocketClient["splitPane"]>[0]): Promise<unknown> {
    return (await this.#getClient()).splitPane(params);
  }

  async listPanes(params: Parameters<HerdrSocketClient["listPanes"]>[0] = {}): Promise<unknown> {
    return (await this.#getClient()).listPanes(params);
  }

  async getPane(params: Parameters<HerdrSocketClient["getPane"]>[0]): Promise<unknown> {
    return (await this.#getClient()).getPane(params);
  }

  async sendPaneInput(params: Parameters<HerdrSocketClient["sendPaneInput"]>[0]): Promise<unknown> {
    return (await this.#getClient()).sendPaneInput(params);
  }

  async sendPaneText(params: Parameters<HerdrSocketClient["sendPaneText"]>[0]): Promise<unknown> {
    return (await this.#getClient()).sendPaneText(params);
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

  async listAgents(params: Parameters<HerdrSocketClient["listAgents"]>[0] = {}): Promise<unknown> {
    return (await this.#getClient()).listAgents(params);
  }

  async getAgent(params: Parameters<HerdrSocketClient["getAgent"]>[0]): Promise<unknown> {
    return (await this.#getClient()).getAgent(params);
  }

  async focusAgent(params: Parameters<HerdrSocketClient["focusAgent"]>[0]): Promise<unknown> {
    return (await this.#getClient()).focusAgent(params);
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

  async waitForEvent(params: Parameters<HerdrSocketClient["waitForEvent"]>[0]): Promise<unknown> {
    return (await this.#getClient()).waitForEvent(params);
  }

  async sessionSnapshot(): Promise<unknown> {
    return (await this.#getClient()).sessionSnapshot();
  }

  async *subscribeEvents(
    params?: Parameters<HerdrSocketClient["subscribeEvents"]>[0],
    options?: Parameters<HerdrSocketClient["subscribeEvents"]>[1],
  ): AsyncIterable<unknown> {
    yield* (await this.#getClient()).subscribeEvents(
      params ?? { paneIds: [], workspaceId: "" },
      options,
    );
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
