import { Type } from "@sinclair/typebox";
import type { ShepherdConfig } from "@/config/schema.js";
import type { EventStore } from "@/db/event-store.js";
import type { WorkingContextResolver } from "@/gateway/working-contexts.js";
import { herdrSessionNameForWorkingContext } from "@/herdr/naming.js";
import type { HerdrOrchestrator } from "@/herdr/orchestrator.js";
import { LogicalToolRegistry } from "./tools.js";

export type BuiltinToolDependencies = {
  agents?: ShepherdConfig["agents"];
  events: EventStore;
  herdr: HerdrOrchestrator;
  workingContexts?: WorkingContextResolver;
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

type AttachHerdrWorkspaceInput = {
  confirmedUserRequestedAttach: true;
  herdrSessionName: string;
  tabs?: Record<string, string>;
  workspaceId: string;
};

type WorkspaceDiscoveryInput = {
  scanAllowedRoots?: boolean;
};

type ResolveWorkingContextInput = {
  label?: string;
  path?: string;
  slug?: string;
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

type OpenPaneInput = EnsureHerdrWorkspaceInput & {
  cwd?: string;
  direction?: "down" | "right";
  focus?: boolean;
  ratio?: number;
  tabLabel?: string;
  targetPaneId?: string;
};

type RunPaneCommandInput = {
  command: string;
  paneId: string;
  workingContextSlug: string;
};

type ReadPaneInput = {
  lines?: number;
  paneId: string;
  source?: "all" | "recent";
  workingContextSlug: string;
};

type WaitForAgentInput = {
  status: "blocked" | "done" | "idle" | "unknown" | "working";
  target: string;
  timeoutMs?: number;
  workingContextSlug: string;
};

type WaitForHerdrEventInput = {
  lines?: number;
  match: string;
  paneId: string;
  regex?: boolean;
  source?: "recent" | "recent-unwrapped" | "visible";
  timeoutMs?: number;
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
    description: "Discover recent and optionally allowed-root working context candidates.",
    execute: (input: WorkspaceDiscoveryInput) => {
      if (!deps.workingContexts) {
        throw new Error("Working context resolver is not configured");
      }

      return deps.workingContexts.discover(input);
    },
    inputSchema: Type.Object({
      scanAllowedRoots: Type.Optional(Type.Boolean()),
    }),
    name: "workspace_discovery",
  });

  registry.register({
    description: "Resolve or create a working context from a known slug or allowed path.",
    execute: (input: ResolveWorkingContextInput) => {
      if (!deps.workingContexts) {
        throw new Error("Working context resolver is not configured");
      }

      return deps.workingContexts.resolve(input);
    },
    inputSchema: Type.Object({
      label: Type.Optional(Type.String({ minLength: 1 })),
      path: Type.Optional(Type.String({ minLength: 1 })),
      slug: Type.Optional(Type.String({ minLength: 1 })),
    }),
    name: "resolve_working_context",
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
    description: "Alias for ensure_herdr_workspace.",
    execute: (input: EnsureHerdrWorkspaceInput, context) =>
      registry.get("ensure_herdr_workspace").execute(input, context),
    inputSchema: Type.Object({
      taskSlug: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
      workingDirectory: Type.String({ minLength: 1 }),
    }),
    name: "ensure_agent_pane",
  });

  registry.register({
    description:
      "Attach the current Shepherd session to an existing Herdr session/workspace only after the user explicitly asks.",
    execute: (input: AttachHerdrWorkspaceInput, context) =>
      deps.herdr.attachWorkspace({
        herdrSessionName: input.herdrSessionName,
        sessionId: context.sessionId,
        ...(input.tabs !== undefined ? { tabs: input.tabs } : {}),
        workspaceId: input.workspaceId,
      }),
    inputSchema: Type.Object({
      confirmedUserRequestedAttach: Type.Literal(true),
      herdrSessionName: Type.String({ minLength: 1 }),
      tabs: Type.Optional(
        Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 })),
      ),
      workspaceId: Type.String({ minLength: 1 }),
    }),
    name: "attach_herdr_workspace",
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
    description: "Start a configured coding agent in Herdr.",
    execute: (input: HerdrStartAgentInput, context) =>
      registry.get("herdr_start_agent").execute(input, context),
    inputSchema: Type.Object({
      agentName: Type.String({ minLength: 1 }),
      agentProfile: Type.String({ minLength: 1 }),
      taskSlug: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
      workingDirectory: Type.String({ minLength: 1 }),
    }),
    name: "start_agent",
  });

  registry.register({
    description: "Open a Shepherd-managed Herdr pane by splitting a pane or workspace.",
    execute: (input: OpenPaneInput, context) =>
      deps.herdr.openPane({
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        sessionId: context.sessionId,
        taskSlug: input.taskSlug,
        workingDirectory: input.workingDirectory,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.focus !== undefined ? { focus: input.focus } : {}),
        ...(input.ratio !== undefined ? { ratio: input.ratio } : {}),
        ...(input.tabLabel !== undefined ? { tabLabel: input.tabLabel } : {}),
        ...(input.targetPaneId !== undefined ? { targetPaneId: input.targetPaneId } : {}),
      }),
    inputSchema: Type.Object({
      cwd: Type.Optional(Type.String({ minLength: 1 })),
      direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
      focus: Type.Optional(Type.Boolean()),
      ratio: Type.Optional(Type.Number({ minimum: 0.05, maximum: 0.95 })),
      tabLabel: Type.Optional(Type.String({ minLength: 1 })),
      targetPaneId: Type.Optional(Type.String({ minLength: 1 })),
      taskSlug: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
      workingDirectory: Type.String({ minLength: 1 }),
    }),
    name: "open_pane",
  });

  registry.register({
    description: "Run a shell command in a Herdr pane.",
    execute: (input: RunPaneCommandInput) =>
      deps.herdr.runPaneCommand({
        command: input.command,
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        paneId: input.paneId,
      }),
    inputSchema: Type.Object({
      command: Type.String({ minLength: 1 }),
      paneId: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
    }),
    name: "run_pane_command",
  });

  registry.register({
    description: "Read recent output from a Herdr pane.",
    execute: (input: ReadPaneInput) =>
      deps.herdr.readPane({
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        paneId: input.paneId,
        ...(input.lines !== undefined ? { lines: input.lines } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      }),
    inputSchema: Type.Object({
      lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      paneId: Type.String({ minLength: 1 }),
      source: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("recent")])),
      workingContextSlug: Type.String({ minLength: 1 }),
    }),
    name: "read_pane",
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
    description: "Send a user message to a Herdr-managed agent target.",
    execute: (input: HerdrSendAgentMessageInput, context) =>
      registry.get("herdr_send_agent_message").execute(input, context),
    inputSchema: Type.Object({
      target: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
    }),
    name: "send_agent_message",
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

  registry.register({
    description: "Read recent output from a Herdr-managed agent target.",
    execute: (input: HerdrReadAgentInput, context) =>
      registry.get("herdr_read_agent").execute(input, context),
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
    name: "read_agent_output",
  });

  registry.register({
    description: "Wait for a Herdr-managed agent target to reach a status.",
    execute: (input: WaitForAgentInput) =>
      deps.herdr.waitForAgent({
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        status: input.status,
        target: input.target,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      }),
    inputSchema: Type.Object({
      status: Type.Union([
        Type.Literal("idle"),
        Type.Literal("working"),
        Type.Literal("blocked"),
        Type.Literal("done"),
        Type.Literal("unknown"),
      ]),
      target: Type.String({ minLength: 1 }),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
      workingContextSlug: Type.String({ minLength: 1 }),
    }),
    name: "wait_for_agent",
  });

  registry.register({
    description: "Wait for a Herdr pane output match.",
    execute: (input: WaitForHerdrEventInput) =>
      deps.herdr.waitForOutput({
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        match: input.match,
        paneId: input.paneId,
        ...(input.lines !== undefined ? { lines: input.lines } : {}),
        ...(input.regex !== undefined ? { regex: input.regex } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      }),
    inputSchema: Type.Object({
      lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      match: Type.String({ minLength: 1 }),
      paneId: Type.String({ minLength: 1 }),
      regex: Type.Optional(Type.Boolean()),
      source: Type.Optional(
        Type.Union([
          Type.Literal("recent"),
          Type.Literal("recent-unwrapped"),
          Type.Literal("visible"),
        ]),
      ),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
      workingContextSlug: Type.String({ minLength: 1 }),
    }),
    name: "wait_for_herdr_event",
  });

  return registry;
}
