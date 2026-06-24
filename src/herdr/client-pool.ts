export type ClosableHerdrClient = {
  close(): void;
};

export type HerdrClientPoolOptions<Client extends ClosableHerdrClient> = {
  createClient: (herdrSessionName: string) => Client;
};

export class HerdrClientPool<Client extends ClosableHerdrClient> {
  readonly #clients = new Map<string, Client>();
  readonly #createClient: (herdrSessionName: string) => Client;

  constructor(options: HerdrClientPoolOptions<Client>) {
    this.#createClient = options.createClient;
  }

  get(herdrSessionName: string): Client {
    const existing = this.#clients.get(herdrSessionName);
    if (existing) {
      return existing;
    }

    const client = this.#createClient(herdrSessionName);
    this.#clients.set(herdrSessionName, client);
    return client;
  }

  closeAll(): void {
    for (const client of this.#clients.values()) {
      client.close();
    }
    this.#clients.clear();
  }
}
