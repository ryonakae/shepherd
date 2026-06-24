import { Type } from "@sinclair/typebox";
import type { EventStore } from "@/db/event-store.js";
import { herdrSessionNameForWorkingContext } from "@/herdr/naming.js";
import type { HerdrOrchestrator } from "@/herdr/orchestrator.js";
import { LogicalToolRegistry } from "./tools.js";

export type BuiltinToolDependencies = {
  events: EventStore;
  herdr: HerdrOrchestrator;
};

type SessionReadInput = {
  afterEventId?: number;
  includeInternal?: boolean;
  limit?: number;
};

type EnsureHerdrWorkspaceInput = {
  taskSlug: string;
  workingContextSlug: string;
  workingDirectory: string;
};

export function createBuiltinToolRegistry(deps: BuiltinToolDependencies): LogicalToolRegistry {
  const registry = new LogicalToolRegistry();

  registry.register({
    description: "Read recent Shepherd session events after an optional cursor.",
    execute: (input: SessionReadInput, context) =>
      deps.events
        .listEvents(context.sessionId, input.afterEventId ?? 0, input.limit ?? 50)
        .filter((event) => input.includeInternal || !event.type.startsWith("gateway.tool.")),
    inputSchema: Type.Object({
      afterEventId: Type.Optional(Type.Number()),
      includeInternal: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    name: "session_read",
  });

  registry.register({
    description: "Ensure a Shepherd-managed Herdr workspace and standard tabs exist.",
    execute: (input: EnsureHerdrWorkspaceInput, context) =>
      deps.herdr.ensureWorkspace({
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        sessionId: context.sessionId,
        taskSlug: input.taskSlug,
        workingDirectory: input.workingDirectory,
      }),
    inputSchema: Type.Object({
      taskSlug: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
      workingDirectory: Type.String({ minLength: 1 }),
    }),
    name: "ensure_herdr_workspace",
  });

  return registry;
}
