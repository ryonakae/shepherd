import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { herdrWorkspaceNameForTask } from "./naming.js";
import type { HerdrSocketClient } from "./socket-client.js";

export type EnsureWorkspaceInput = {
  herdrSessionName: string;
  sessionId: string;
  taskSlug: string;
  workingDirectory: string;
};

export type AttachWorkspaceInput = {
  herdrSessionName: string;
  sessionId: string;
  tabs?: Record<string, string>;
  workspaceId: string;
};

export type HerdrAgentProfile = {
  args?: string[];
  command: string;
};

export type StartAgentInput = EnsureWorkspaceInput & {
  agentName: string;
  profile: HerdrAgentProfile;
  tabLabel?: string;
};

type WorkspaceResult = {
  id?: string;
  workspace_id?: string;
};

type TabResult = {
  id?: string;
  tab_id?: string;
};

type AgentStartResult = {
  agent?: { pane_id?: string };
  id?: string;
  pane?: { pane_id?: string };
  pane_id?: string;
};

export type HerdrControlClient = Pick<
  HerdrSocketClient,
  | "createTab"
  | "createWorkspace"
  | "focusAgent"
  | "focusWorkspace"
  | "getAgent"
  | "getPane"
  | "getTab"
  | "getWorkspace"
  | "listAgents"
  | "listPanes"
  | "listTabs"
  | "listWorkspaces"
  | "readAgent"
  | "readPane"
  | "runPaneCommand"
  | "sendPaneText"
  | "sendAgentMessage"
  | "splitPane"
  | "startAgent"
  | "waitForAgent"
  | "waitForEvent"
  | "waitForOutput"
>;

export type HerdrReadInput =
  | { herdrSessionName: string; resource: "agents"; workspaceId?: string }
  | { herdrSessionName: string; resource: "agent"; target: string }
  | { herdrSessionName: string; resource: "panes"; tabId?: string; workspaceId?: string }
  | { herdrSessionName: string; paneId: string; resource: "pane" }
  | { herdrSessionName: string; resource: "tabs"; workspaceId?: string }
  | { herdrSessionName: string; resource: "tab"; tabId: string }
  | { herdrSessionName: string; resource: "workspaces" }
  | { herdrSessionName: string; resource: "workspace"; workspaceId: string };

export type HerdrWorkspaceBinding = {
  herdrSessionName: string;
  tabs: Record<string, string>;
  workspaceId: string;
};

export type HerdrWorkspaceBindingEvent = HerdrWorkspaceBinding & {
  sessionId: string;
};

export type HerdrAgentBinding = {
  agentName: string;
  paneId: string;
  raw: unknown;
  tabId: string | undefined;
  workspaceId: string;
};

export type HerdrPaneBinding = {
  paneId: string | undefined;
  raw: unknown;
  tabId: string | undefined;
  workspaceId: string;
};

export class HerdrOrchestrator {
  readonly #clientForSession: (herdrSessionName: string) => HerdrControlClient;
  readonly #onWorkspaceBound: ((binding: HerdrWorkspaceBindingEvent) => void) | undefined;
  readonly #sqlite: DatabaseSync;

  constructor(options: {
    clientForSession?: (herdrSessionName: string) => HerdrControlClient;
    herdr?: HerdrControlClient;
    onWorkspaceBound?: (binding: HerdrWorkspaceBindingEvent) => void;
    sqlite: DatabaseSync;
  }) {
    if (!options.clientForSession && !options.herdr) {
      throw new Error("HerdrOrchestrator requires herdr or clientForSession");
    }

    this.#clientForSession =
      options.clientForSession ?? (() => options.herdr as HerdrControlClient);
    this.#onWorkspaceBound = options.onWorkspaceBound;
    this.#sqlite = options.sqlite;
  }

  async ensureWorkspace(input: EnsureWorkspaceInput): Promise<HerdrWorkspaceBinding> {
    const existing = this.#getBinding(input.sessionId);
    if (existing) {
      this.#emitWorkspaceBound(input.sessionId, existing);
      return existing;
    }

    const herdr = this.#clientForSession(input.herdrSessionName);
    const workspace = (await herdr.createWorkspace({
      cwd: input.workingDirectory,
      label: herdrWorkspaceNameForTask(input.taskSlug, input.sessionId.slice(0, 8)),
    })) as WorkspaceResult;
    const workspaceId = workspace.workspace_id ?? workspace.id;
    if (!workspaceId) {
      throw new Error("Herdr workspace.create response did not include a workspace id");
    }

    const tabs: Record<string, string> = {};
    for (const label of ["agents", "tests", "logs", "review", "scratch"]) {
      const tab = (await herdr.createTab({
        label,
        workspace_id: workspaceId,
      })) as TabResult;
      const tabId = tab.tab_id ?? tab.id;
      if (!tabId) {
        throw new Error("Herdr tab.create response did not include a tab id");
      }
      tabs[label] = tabId;
    }

    const now = Date.now();
    this.#sqlite
      .prepare(
        "insert into herdr_bindings (id, session_id, herdr_session_name, workspace_id, metadata_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        input.sessionId,
        input.herdrSessionName,
        workspaceId,
        JSON.stringify({ created: true, tabs }),
        now,
        now,
      );

    const binding = {
      herdrSessionName: input.herdrSessionName,
      tabs,
      workspaceId,
    };
    this.#emitWorkspaceBound(input.sessionId, binding);

    return binding;
  }

  attachWorkspace(input: AttachWorkspaceInput): HerdrWorkspaceBinding {
    const existing = this.#getBinding(input.sessionId);
    if (existing) {
      if (
        existing.herdrSessionName !== input.herdrSessionName ||
        existing.workspaceId !== input.workspaceId
      ) {
        throw new Error(`Shepherd session already has a Herdr binding: ${input.sessionId}`);
      }

      return existing;
    }

    const now = Date.now();
    const tabs = input.tabs ?? {};
    this.#sqlite
      .prepare(
        "insert into herdr_bindings (id, session_id, herdr_session_name, workspace_id, metadata_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        input.sessionId,
        input.herdrSessionName,
        input.workspaceId,
        JSON.stringify({ attached: true, tabs }),
        now,
        now,
      );

    const binding = {
      herdrSessionName: input.herdrSessionName,
      tabs,
      workspaceId: input.workspaceId,
    };
    this.#emitWorkspaceBound(input.sessionId, binding);

    return binding;
  }

  readHerdr(input: HerdrReadInput): Promise<unknown> {
    const herdr = this.#clientForSession(input.herdrSessionName);
    switch (input.resource) {
      case "agents":
        return herdr.listAgents(
          input.workspaceId === undefined ? {} : { workspace_id: input.workspaceId },
        );
      case "agent":
        return herdr.getAgent({ target: input.target });
      case "panes":
        return herdr.listPanes({
          ...(input.tabId !== undefined ? { tab_id: input.tabId } : {}),
          ...(input.workspaceId !== undefined ? { workspace_id: input.workspaceId } : {}),
        });
      case "pane":
        return herdr.getPane({ pane_id: input.paneId });
      case "tabs":
        return herdr.listTabs(
          input.workspaceId === undefined ? {} : { workspace_id: input.workspaceId },
        );
      case "tab":
        return herdr.getTab({ tab_id: input.tabId });
      case "workspaces":
        return herdr.listWorkspaces();
      case "workspace":
        return herdr.getWorkspace({ workspace_id: input.workspaceId });
    }
  }

  async startAgent(input: StartAgentInput): Promise<HerdrAgentBinding> {
    const binding = await this.ensureWorkspace(input);
    const herdr = this.#clientForSession(binding.herdrSessionName);
    const tabId = binding.tabs[input.tabLabel ?? "agents"];
    const startParams = {
      command: input.profile.command,
      cwd: input.workingDirectory,
      name: input.agentName,
      workspace_id: binding.workspaceId,
      ...(input.profile.args !== undefined ? { args: input.profile.args } : {}),
      ...(tabId !== undefined ? { tab_id: tabId } : {}),
    };
    const result = (await herdr.startAgent(startParams)) as AgentStartResult;
    const paneId = result.pane_id ?? result.pane?.pane_id ?? result.agent?.pane_id ?? result.id;
    if (!paneId) {
      throw new Error("Herdr agent.start response did not include a pane id");
    }

    return {
      agentName: input.agentName,
      paneId,
      raw: result,
      tabId,
      workspaceId: binding.workspaceId,
    };
  }

  readAgent(params: {
    herdrSessionName: string;
    lines?: number;
    source?: "detection" | "recent" | "recent-unwrapped" | "visible";
    target: string;
  }): Promise<unknown> {
    const { herdrSessionName, ...request } = params;
    return this.#clientForSession(herdrSessionName).readAgent(request);
  }

  async openPane(
    params: EnsureWorkspaceInput & {
      cwd?: string;
      direction?: "down" | "right";
      focus?: boolean;
      ratio?: number;
      tabLabel?: string;
      targetPaneId?: string;
    },
  ): Promise<HerdrPaneBinding> {
    const binding = await this.ensureWorkspace(params);
    const herdr = this.#clientForSession(binding.herdrSessionName);
    const tabId = params.tabLabel ? binding.tabs[params.tabLabel] : undefined;
    const result = (await herdr.splitPane({
      direction: params.direction ?? "right",
      workspace_id: binding.workspaceId,
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(params.focus !== undefined ? { focus: params.focus } : {}),
      ...(params.ratio !== undefined ? { ratio: params.ratio } : {}),
      ...(params.targetPaneId !== undefined ? { pane_id: params.targetPaneId } : {}),
      ...(tabId !== undefined ? { tab_id: tabId } : {}),
    })) as { id?: string; pane?: { pane_id?: string }; pane_id?: string };

    return {
      paneId: result.pane_id ?? result.pane?.pane_id ?? result.id,
      raw: result,
      tabId,
      workspaceId: binding.workspaceId,
    };
  }

  readPane(params: {
    herdrSessionName: string;
    lines?: number;
    paneId: string;
    source?: "all" | "recent";
  }): Promise<unknown> {
    const { herdrSessionName, paneId, ...request } = params;
    return this.#clientForSession(herdrSessionName).readPane({
      ...request,
      pane_id: paneId,
    });
  }

  runPaneCommand(params: {
    command: string;
    herdrSessionName: string;
    paneId: string;
  }): Promise<unknown> {
    const { herdrSessionName, paneId, ...request } = params;
    return this.#clientForSession(herdrSessionName).runPaneCommand({
      ...request,
      pane_id: paneId,
    });
  }

  sendPaneText(params: {
    herdrSessionName: string;
    paneId: string;
    text: string;
  }): Promise<unknown> {
    const { herdrSessionName, paneId, ...request } = params;
    return this.#clientForSession(herdrSessionName).sendPaneText({
      ...request,
      pane_id: paneId,
    });
  }

  sendAgentMessage(params: {
    herdrSessionName: string;
    target: string;
    text: string;
  }): Promise<unknown> {
    const { herdrSessionName, ...request } = params;
    return this.#clientForSession(herdrSessionName).sendAgentMessage(request);
  }

  waitForAgent(params: {
    herdrSessionName: string;
    status: "blocked" | "done" | "idle" | "unknown" | "working";
    target: string;
    timeoutMs?: number;
  }): Promise<unknown> {
    const { herdrSessionName, timeoutMs, ...request } = params;
    return this.#clientForSession(herdrSessionName).waitForAgent({
      ...request,
      ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    });
  }

  waitForOutput(params: {
    herdrSessionName: string;
    lines?: number;
    match: string;
    paneId: string;
    regex?: boolean;
    source?: "recent" | "recent-unwrapped" | "visible";
    timeoutMs?: number;
  }): Promise<unknown> {
    const { herdrSessionName, paneId, timeoutMs, ...request } = params;
    return this.#clientForSession(herdrSessionName).waitForOutput({
      ...request,
      pane_id: paneId,
      ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    });
  }

  waitForEvent(params: {
    herdrSessionName: string;
    timeoutMs?: number;
    workspaceId?: string;
  }): Promise<unknown> {
    const { herdrSessionName, timeoutMs, workspaceId } = params;
    return this.#clientForSession(herdrSessionName).waitForEvent({
      ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
      ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
    });
  }

  #getBinding(sessionId: string): HerdrWorkspaceBinding | undefined {
    const row = this.#sqlite
      .prepare(
        "select herdr_session_name, workspace_id, metadata_json from herdr_bindings where session_id = ?",
      )
      .get(sessionId) as
      | { herdr_session_name: string; metadata_json: string | null; workspace_id: string }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      herdrSessionName: row.herdr_session_name,
      tabs: row.metadata_json
        ? ((JSON.parse(row.metadata_json) as { tabs?: Record<string, string> }).tabs ?? {})
        : {},
      workspaceId: row.workspace_id,
    };
  }

  #emitWorkspaceBound(sessionId: string, binding: HerdrWorkspaceBinding): void {
    this.#onWorkspaceBound?.({ ...binding, sessionId });
  }
}
