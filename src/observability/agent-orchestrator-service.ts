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
    const change = this.#scopes.claim({ ...input, ackedEventId: this.#claimCursor(input) });
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
        if (event.terminalId !== null && event.terminalId !== input.terminalId) pending.push(event);
        if (pending.length === limit) break;
      }
    }
    return pending;
  }

  ack(input: AgentScope & { eventId: number; terminalId: string }): AgentOrchestratorState {
    const state = this.#scopes.get(input);
    if (!state?.owner || state.owner.terminalId !== input.terminalId) {
      throw new Error("Only the current orchestrator can acknowledge notifications");
    }
    if (input.eventId <= state.ackedEventId) return state;
    const next = this.#agentEvents.nextDeliverableAfter({
      ...input,
      afterEventId: state.ackedEventId,
      ownerTerminalId: input.terminalId,
    });
    if (next?.id !== input.eventId) {
      throw new Error("Only the next pending orchestrator event can be acknowledged");
    }
    return this.#scopes.ack(input);
  }

  move(input: {
    from: AgentScope;
    paneId: string;
    terminalId: string;
    to: AgentScope;
  }): AgentOrchestratorChange[] {
    return this.#scopes
      .moveOwner({ ...input, targetAckedEventId: this.#claimCursor(input.to) })
      .map((change) => ({ ...change, reason: "moved" }));
  }

  persistedOwners(): AgentOrchestratorState[] {
    return this.#scopes.listOwned();
  }

  #claimCursor(scope: AgentScope): number {
    const current = this.#scopes.get(scope);
    return current?.owner ? current.ackedEventId : this.#agentEvents.latestEventId(scope);
  }
}
