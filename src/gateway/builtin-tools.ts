import { Type } from "@sinclair/typebox";
import type { ShepherdConfig } from "@/config/schema.js";
import type { EventStore } from "@/db/event-store.js";
import type { WorkerAgentBindingStore, WorkerAgentRole } from "@/db/worker-agent-bindings.js";
import type { WorkingContextResolver } from "@/gateway/working-contexts.js";
import { herdrSessionNameForWorkingContext } from "@/herdr/naming.js";
import type { HerdrOrchestrator } from "@/herdr/orchestrator.js";
import { LogicalToolRegistry } from "./tools.js";

export type BuiltinToolDependencies = {
  agents?: ShepherdConfig["agents"];
  events: EventStore;
  herdr: HerdrOrchestrator;
  workerBindings?: WorkerAgentBindingStore;
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

type HerdrReadInput = {
  paneId?: string;
  resource: "agent" | "agents" | "pane" | "panes" | "tab" | "tabs" | "workspace" | "workspaces";
  tabId?: string;
  target?: string;
  workingContextSlug: string;
  workspaceId?: string;
};

type EnsureWorkerAgentInput = EnsureHerdrWorkspaceInput & {
  agentName: string;
  agentProfile: string;
  description?: string;
  lastTask?: string;
  role: WorkerAgentRole;
};

type ListWorkerAgentsInput = {
  sessionScope?: "current";
};

type GetWorkerAgentInput = {
  agentName: string;
  workspaceId?: string;
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

type SendPaneTextInput = {
  paneId: string;
  text: string;
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
        .filter((event) => input.includeInternal || !event.type.startsWith("pi.tool.")),
    inputSchema: Type.Object({
      afterEventId: Type.Optional(Type.Number()),
      includeInternal: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    name: "session_read",
    promptSnippet:
      "Use shepherd_session_read to inspect recent Shepherd session events and orchestration history.",
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
    promptSnippet:
      "Use shepherd_workspace_discovery to find known or allowed working contexts before binding Herdr resources.",
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
    promptGuidelines: [
      "Use shepherd_resolve_working_context before creating Herdr resources when the working context is ambiguous.",
    ],
    promptSnippet:
      "Use shepherd_resolve_working_context to resolve a project path, label, or slug into a Shepherd working context.",
  });

  registry.register({
    description: "Inspect Herdr workspaces, tabs, panes, or agents through Shepherd bindings.",
    execute: (input: HerdrReadInput) => {
      const herdrSessionName = herdrSessionNameForWorkingContext(input.workingContextSlug);
      switch (input.resource) {
        case "agent":
          if (!input.target) {
            throw new Error("target is required for agent reads");
          }
          return deps.herdr.readHerdr({
            herdrSessionName,
            resource: "agent",
            target: input.target,
          });
        case "pane":
          if (!input.paneId) {
            throw new Error("paneId is required for pane reads");
          }
          return deps.herdr.readHerdr({ herdrSessionName, paneId: input.paneId, resource: "pane" });
        case "tab":
          if (!input.tabId) {
            throw new Error("tabId is required for tab reads");
          }
          return deps.herdr.readHerdr({ herdrSessionName, resource: "tab", tabId: input.tabId });
        case "workspace":
          if (!input.workspaceId) {
            throw new Error("workspaceId is required for workspace reads");
          }
          return deps.herdr.readHerdr({
            herdrSessionName,
            resource: "workspace",
            workspaceId: input.workspaceId,
          });
        case "agents":
          return deps.herdr.readHerdr({
            herdrSessionName,
            resource: "agents",
            ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          });
        case "panes":
          return deps.herdr.readHerdr({
            herdrSessionName,
            resource: "panes",
            ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
            ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          });
        case "tabs":
          return deps.herdr.readHerdr({
            herdrSessionName,
            resource: "tabs",
            ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          });
        case "workspaces":
          return deps.herdr.readHerdr({ herdrSessionName, resource: "workspaces" });
      }
    },
    inputSchema: Type.Object({
      paneId: Type.Optional(Type.String({ minLength: 1 })),
      resource: Type.Union([
        Type.Literal("workspaces"),
        Type.Literal("workspace"),
        Type.Literal("tabs"),
        Type.Literal("tab"),
        Type.Literal("panes"),
        Type.Literal("pane"),
        Type.Literal("agents"),
        Type.Literal("agent"),
      ]),
      tabId: Type.Optional(Type.String({ minLength: 1 })),
      target: Type.Optional(Type.String({ minLength: 1 })),
      workingContextSlug: Type.String({ minLength: 1 }),
      workspaceId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    name: "herdr_read",
    promptGuidelines: [
      "Use shepherd_herdr_read to inspect current Herdr state before creating duplicate workspaces, panes, or agents.",
    ],
    promptSnippet:
      "Use shepherd_herdr_read to inspect Shepherd-bound Herdr workspaces, tabs, panes, and agents.",
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
    name: "ensure_workspace",
    promptGuidelines: [
      "Use shepherd_ensure_workspace for Shepherd-managed work; do not attach user-owned Herdr workspaces with it.",
    ],
    promptSnippet:
      "Use shepherd_ensure_workspace to create or reuse the Shepherd-managed Herdr workspace for a task.",
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
    name: "attach_workspace",
    promptGuidelines: [
      "Use shepherd_attach_workspace only when the user explicitly asks to attach an existing non-Shepherd Herdr workspace.",
    ],
    promptSnippet:
      "Use shepherd_attach_workspace to bind an explicitly requested existing Herdr workspace to the current Shepherd session.",
  });

  registry.register({
    description: "Ensure a configured worker agent exists inside the Shepherd Herdr workspace.",
    execute: async (input: EnsureWorkerAgentInput, context) => {
      const profile = deps.agents?.[input.agentProfile];
      if (!profile) {
        throw new Error(`Unknown agent profile: ${input.agentProfile}`);
      }

      const herdrSessionName = herdrSessionNameForWorkingContext(input.workingContextSlug);
      const workspace = await deps.herdr.ensureWorkspace({
        herdrSessionName,
        sessionId: context.sessionId,
        taskSlug: input.taskSlug,
        workingDirectory: input.workingDirectory,
      });
      const existing = deps.workerBindings
        ? tryGetWorkerBinding(deps.workerBindings, {
            agentName: input.agentName,
            sessionId: context.sessionId,
            workspaceId: workspace.workspaceId,
          })
        : undefined;
      if (existing) {
        return existing;
      }

      const started = await deps.herdr.startAgent({
        agentName: input.agentName,
        herdrSessionName,
        profile,
        sessionId: context.sessionId,
        taskSlug: input.taskSlug,
        workingDirectory: input.workingDirectory,
      });
      if (!deps.workerBindings) {
        return started;
      }
      const binding = deps.workerBindings.upsertBinding({
        agentName: input.agentName,
        agentProfile: input.agentProfile,
        agentStatus: "unknown",
        bindingHealth: "present",
        ...(input.description !== undefined ? { description: input.description } : {}),
        herdrSessionName,
        ...(input.lastTask !== undefined ? { lastTask: input.lastTask } : {}),
        paneId: started.paneId,
        role: input.role,
        sessionId: context.sessionId,
        ...(started.tabId !== undefined ? { tabId: started.tabId } : {}),
        workspaceId: started.workspaceId,
      });
      deps.events.appendEvent({
        payload: binding,
        sessionId: context.sessionId,
        type: "worker_agent.bound",
      });
      return binding;
    },
    inputSchema: Type.Object({
      agentName: Type.String({ minLength: 1 }),
      agentProfile: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String({ minLength: 1 })),
      lastTask: Type.Optional(Type.String({ minLength: 1 })),
      role: Type.Union([
        Type.Literal("implementation"),
        Type.Literal("review"),
        Type.Literal("research"),
        Type.Literal("test"),
        Type.Literal("general"),
      ]),
      taskSlug: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
      workingDirectory: Type.String({ minLength: 1 }),
    }),
    name: "ensure_worker_agent",
    promptGuidelines: [
      "Use shepherd_ensure_worker_agent to ensure or reuse configured Herdr worker agents instead of doing long-running work in Pi.",
    ],
    promptSnippet:
      "Use shepherd_ensure_worker_agent to ensure or reuse a configured worker agent inside the Shepherd-managed Herdr workspace.",
  });

  registry.register({
    description: "List Shepherd worker agent bindings for the current session.",
    execute: (_input: ListWorkerAgentsInput, context) => {
      if (!deps.workerBindings) {
        throw new Error("Worker agent binding store is not configured");
      }
      return deps.workerBindings.listForSession(context.sessionId);
    },
    inputSchema: Type.Object({
      sessionScope: Type.Optional(Type.Literal("current")),
    }),
    name: "list_worker_agents",
    promptGuidelines: [
      "Use shepherd_list_worker_agents to inspect existing worker agents before starting another one.",
    ],
    promptSnippet:
      "Use shepherd_list_worker_agents to inspect Shepherd worker agents bound to the current session.",
  });

  registry.register({
    description: "Get one Shepherd worker agent binding by name and optional workspace id.",
    execute: (input: GetWorkerAgentInput, context) => {
      if (!deps.workerBindings) {
        throw new Error("Worker agent binding store is not configured");
      }
      if (input.workspaceId) {
        return deps.workerBindings.getByAgentName({
          agentName: input.agentName,
          sessionId: context.sessionId,
          workspaceId: input.workspaceId,
        });
      }
      const matches = deps.workerBindings
        .listForSession(context.sessionId)
        .filter((binding) => binding.agentName === input.agentName);
      if (matches.length === 0) {
        throw new Error("Worker agent binding not found");
      }
      if (matches.length > 1) {
        throw new Error("workspaceId is required because multiple worker agents match");
      }
      return matches[0];
    },
    inputSchema: Type.Object({
      agentName: Type.String({ minLength: 1 }),
      workspaceId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    name: "get_worker_agent",
    promptGuidelines: [
      "Use shepherd_get_worker_agent to inspect a known worker binding without querying raw Herdr state.",
    ],
    promptSnippet:
      "Use shepherd_get_worker_agent to inspect one Shepherd worker agent binding by name.",
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
    name: "herdr_open_pane",
    promptSnippet:
      "Use shepherd_herdr_open_pane to open a Shepherd-managed Herdr pane for shells, logs, servers, or tests.",
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
    name: "herdr_run_pane_command",
    promptGuidelines: [
      "Use shepherd_herdr_run_pane_command only inside Shepherd-managed Herdr panes for tests, servers, logs, and controlled terminal workflows.",
    ],
    promptSnippet:
      "Use shepherd_herdr_run_pane_command to run a command in a Shepherd-managed Herdr pane.",
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
    name: "herdr_read_pane",
    promptSnippet:
      "Use shepherd_herdr_read_pane to read recent output from a Shepherd-managed Herdr pane.",
  });

  registry.register({
    description: "Send literal text to a Herdr pane.",
    execute: (input: SendPaneTextInput) =>
      deps.herdr.sendPaneText({
        herdrSessionName: herdrSessionNameForWorkingContext(input.workingContextSlug),
        paneId: input.paneId,
        text: input.text,
      }),
    inputSchema: Type.Object({
      paneId: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1 }),
      workingContextSlug: Type.String({ minLength: 1 }),
    }),
    name: "herdr_send_pane_text",
    promptSnippet:
      "Use shepherd_herdr_send_pane_text to send literal text to a Shepherd-managed Herdr pane.",
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
    promptGuidelines: [
      "Use shepherd_herdr_send_agent_message for follow-up instructions to Herdr worker agents after reading their current state.",
    ],
    promptSnippet:
      "Use shepherd_herdr_send_agent_message to send the user's task or follow-up to a Herdr-managed agent.",
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
    promptSnippet:
      "Use shepherd_herdr_read_agent to read recent output from a Herdr-managed agent.",
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
    name: "herdr_wait_for_agent",
    promptGuidelines: [
      "Use shepherd_herdr_wait_for_agent before summarizing delegated Herdr agent work when the agent may still be working.",
    ],
    promptSnippet:
      "Use shepherd_herdr_wait_for_agent to wait for a Herdr-managed agent to become idle, done, blocked, working, or unknown.",
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
    name: "herdr_wait_for_event",
    promptSnippet:
      "Use shepherd_herdr_wait_for_event to wait for expected text in a Herdr pane before continuing.",
  });

  return registry;
}

function tryGetWorkerBinding(
  store: WorkerAgentBindingStore,
  input: { agentName: string; sessionId: string; workspaceId: string },
) {
  try {
    return store.getByAgentName(input);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Worker agent binding not found")) {
      return undefined;
    }
    throw error;
  }
}
