import { Type } from "@sinclair/typebox";
import type { ShepherdConfig } from "@/config/schema.js";
import type { EventStore } from "@/db/event-store.js";
import { herdrSessionNameForWorkingContext } from "@/herdr/naming.js";
import type { HerdrOrchestrator } from "@/herdr/orchestrator.js";
import { LogicalToolRegistry } from "./tools.js";

export type BuiltinToolDependencies = {
  agents?: ShepherdConfig["agents"];
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

type HerdrStartAgentInput = EnsureHerdrWorkspaceInput & {
  agentName: string;
  agentProfile: string;
};

type HerdrSendAgentMessageInput = {
  target: string;
  text: string;
  workingContextSlug: string;
};

type HerdrReadAgentInput = {
  lines?: number;
  source?: "detection" | "recent" | "recent-unwrapped" | "visible";
  target: string;
  workingContextSlug: string;
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

  registry.register({
    description: "Start a configured coding agent inside the Shepherd Herdr workspace.",
    execute: (input: HerdrStartAgentInput, context) => {
      const profile = deps.agents?.[input.agentProfile];
      if (!profile) {
        throw new Error(`Unknown agent profile: ${input.agentProfile}`);
      }

      return deps.herdr.startAgent({
        agentName: input.agentName,
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        profile,
        sessionId: context.sessionId,
        taskSlug: input.taskSlug,
        workingDirectory: input.workingDirectory,
      });
    },
    inputSchema: Type.Object({
      agentName: Type.String({ minLength: 1 }),
      agentProfile: Type.String({ minLength: 1 }),
      taskSlug: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
      workingDirectory: Type.String({ minLength: 1 }),
    }),
    name: "herdr_start_agent",
  });

  registry.register({
    description: "Send a user message to a Herdr-managed agent target.",
    execute: (input: HerdrSendAgentMessageInput) =>
      deps.herdr.sendAgentMessage({
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        target: input.target,
        text: input.text,
      }),
    inputSchema: Type.Object({
      target: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
    }),
    name: "herdr_send_agent_message",
  });

  registry.register({
    description: "Read recent output from a Herdr-managed agent target.",
    execute: (input: HerdrReadAgentInput) => {
      const request = {
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        target: input.target,
        ...(input.lines !== undefined ? { lines: input.lines } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      };

      return deps.herdr.readAgent(request);
    },
    inputSchema: Type.Object({
      lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      source: Type.Optional(
        Type.Union([
          Type.Literal("detection"),
          Type.Literal("recent"),
          Type.Literal("recent-unwrapped"),
          Type.Literal("visible"),
        ]),
      ),
      target: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
    }),
    name: "herdr_read_agent",
  });

  return registry;
}
