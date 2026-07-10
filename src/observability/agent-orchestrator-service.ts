import type { AgentEventStore } from "@/db/agent-events.js";
import type { AgentOrchestratorScopeStore } from "@/db/agent-orchestrator-scopes.js";
import type { AgentStore } from "@/db/agents.js";
import type {
  AgentEventRecord,
  AgentOrchestratorChangeReason,
  AgentOrchestratorState,
  AgentScope,
} from "@/observability/contracts.js";

export type AgentOrchestratorChange = {
  current: AgentOrchestratorState;
  previous: AgentOrchestratorState;
  reason: AgentOrchestratorChangeReason;
};

export class AgentOrchestratorService {
  readonly #agentEvents: AgentEventStore;
  readonly #scopes: AgentOrchestratorScopeStore;

  constructor(options: {
    agentEvents: AgentEventStore;
    agents: AgentStore;
    scopes: AgentOrchestratorScopeStore;
  }) {
    this.#agentEvents = options.agentEvents;
    this.#scopes = options.scopes;
  }

  status(scope: AgentScope): AgentOrchestratorState | undefined {
    return this.#scopes.get(scope);
  }

  claim(input: AgentScope & { paneId: string; terminalId: string }): AgentOrchestratorChange {
    const initialAckedEventId = this.#scopes.get(input)
      ? 0
      : this.#agentEvents.latestEventId(input);
    const change = this.#scopes.claim({ ...input, initialAckedEventId });
    return { ...change, reason: "claimed" };
  }

  release(
    input: AgentScope & {
      reason: "disconnected" | "released" | "startup_timeout";
      terminalId: string;
    },
  ): AgentOrchestratorChange | undefined {
    const change = this.#scopes.releaseIfOwner(input);
    if (!change.changed || !change.current || !change.previous) return undefined;
    return { current: change.current, previous: change.previous, reason: input.reason };
  }

  pending(input: AgentScope & { limit?: number; terminalId: string }): AgentEventRecord[] {
    const state = this.#scopes.get(input);
    if (!state?.owner || state.owner.terminalId !== input.terminalId) return [];

    const limit = input.limit ?? 100;
    const pending: AgentEventRecord[] = [];
    let afterEventId = state.ackedEventId;
    let scanned = 0;
    while (pending.length < limit && scanned < 1_000) {
      const batch = this.#agentEvents.listAfter({
        ...input,
        afterEventId,
        limit: Math.min(100, 1_000 - scanned),
      });
      if (batch.length === 0) break;
      scanned += batch.length;
      afterEventId = batch.at(-1)?.id ?? afterEventId;
      for (const event of batch) {
        if (event.terminalId !== input.terminalId) pending.push(event);
        if (pending.length === limit) break;
      }
    }
    return pending;
  }

  ack(input: AgentScope & { eventId: number; terminalId: string }): AgentOrchestratorState {
    return this.#scopes.ack(input);
  }

  move(input: {
    from: AgentScope;
    paneId: string;
    terminalId: string;
    to: AgentScope;
  }): AgentOrchestratorChange[] {
    const initialTargetAckedEventId = this.#scopes.get(input.to)
      ? 0
      : this.#agentEvents.latestEventId(input.to);
    return this.#scopes
      .moveOwner({ ...input, initialTargetAckedEventId })
      .map((change) => ({ ...change, reason: "moved" }));
  }

  persistedOwners(): AgentOrchestratorState[] {
    return this.#scopes.listOwned();
  }
}
