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

type WorkspaceResult = {
  id?: string;
  workspace_id?: string;
};

type TabResult = {
  id?: string;
  tab_id?: string;
};

export type HerdrWorkspaceBinding = {
  herdrSessionName: string;
  tabs: Record<string, string>;
  workspaceId: string;
};

export class HerdrOrchestrator {
  readonly #herdr: Pick<HerdrSocketClient, "createTab" | "createWorkspace">;
  readonly #sqlite: DatabaseSync;

  constructor(options: {
    herdr: Pick<HerdrSocketClient, "createTab" | "createWorkspace">;
    sqlite: DatabaseSync;
  }) {
    this.#herdr = options.herdr;
    this.#sqlite = options.sqlite;
  }

  async ensureWorkspace(input: EnsureWorkspaceInput): Promise<HerdrWorkspaceBinding> {
    const existing = this.#getBinding(input.sessionId);
    if (existing) {
      return existing;
    }

    const workspace = (await this.#herdr.createWorkspace({
      cwd: input.workingDirectory,
      label: herdrWorkspaceNameForTask(input.taskSlug, input.sessionId.slice(0, 8)),
    })) as WorkspaceResult;
    const workspaceId = workspace.workspace_id ?? workspace.id;
    if (!workspaceId) {
      throw new Error("Herdr workspace.create response did not include a workspace id");
    }

    const tabs: Record<string, string> = {};
    for (const label of ["agents", "tests", "logs", "review", "scratch"]) {
      const tab = (await this.#herdr.createTab({
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

    return {
      herdrSessionName: input.herdrSessionName,
      tabs,
      workspaceId,
    };
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
}
