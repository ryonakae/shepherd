import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventStore, SessionMetadata } from "@/db/event-store.js";

export type PiSessionMetadata = NonNullable<SessionMetadata["pi"]>;

export class PiSessionMetadataStore {
  readonly #events: EventStore;
  readonly #sessionDir: string;

  constructor(options: { events: EventStore; sessionDir: string }) {
    this.#events = options.events;
    this.#sessionDir = options.sessionDir;
  }

  ensureForSession(sessionId: string): PiSessionMetadata {
    const session = this.#events.getSession(sessionId);
    if (session.metadata.pi) {
      return session.metadata.pi;
    }

    mkdirSync(this.#sessionDir, { recursive: true });
    const now = new Date().toISOString();
    const pi = {
      createdAt: now,
      sessionFile: join(this.#sessionDir, `${sessionId}.jsonl`),
      sessionId: randomUUID(),
      updatedAt: now,
    };
    this.#events.updateSessionMetadata(sessionId, {
      ...session.metadata,
      pi,
    });

    return pi;
  }
}
