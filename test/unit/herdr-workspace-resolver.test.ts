import { describe, expect, test } from "vitest";
import {
  applyHerdrEventToBindings,
  resolveObservedWorkspaceFromSnapshot,
} from "@/herdr/workspace-resolver.js";
import type { ObservedWorkspaceRecord } from "@/observability/contracts.js";

const baseWorkspace: ObservedWorkspaceRecord = {
  createdAt: new Date("2026-07-02T00:00:00.000Z"),
  herdrSessionName: "main",
  id: "ow_1",
  lastResolvedAt: null,
  liveWorkspaceId: "w1",
  metadata: { label: "Repo", workspaceCwd: "/repo" },
  socketPath: null,
  status: "active",
  updatedAt: new Date("2026-07-02T00:00:00.000Z"),
};

describe("Herdr workspace resolver", () => {
  test("pane.moved updates worker live pane identity", () => {
    const updates: unknown[] = [];
    applyHerdrEventToBindings({
      event: {
        pane: { pane_id: "p2", tab_id: "t2", workspace_id: "w1" },
        previous_pane_id: "p1",
        type: "pane.moved",
      },
      observedWorkspace: baseWorkspace,
      observedWorkspaces: fakeObservedWorkspaces(),
      workers: {
        listForWorkspace: () => [
          { currentPaneId: "p1", id: "wk_1" },
          { currentPaneId: "other", id: "wk_2" },
        ],
        updateLiveIdentity: (input: unknown) => updates.push(input),
      },
    });

    expect(updates).toEqual([{ id: "wk_1", paneId: "p2", tabId: "t2", workspaceId: "w1" }]);
  });

  test("workspace.moved keeps the observed workspace active", () => {
    const resolutions: unknown[] = [];
    applyHerdrEventToBindings({
      event: {
        type: "workspace.moved",
        workspace: { id: "w1", label: "Repo", worktree: { checkout_path: "/repo" } },
      },
      observedWorkspace: baseWorkspace,
      observedWorkspaces: fakeObservedWorkspaces((input) => resolutions.push(input)),
      workers: fakeWorkers(),
    });

    expect(resolutions).toEqual([
      {
        id: "ow_1",
        liveWorkspaceId: "w1",
        metadata: { label: "Repo", workspaceCwd: "/repo" },
        status: "active",
      },
    ]);
  });

  test("startup re-resolution finds a workspace by worktree checkout path", () => {
    expect(
      resolveObservedWorkspaceFromSnapshot({
        observedWorkspace: {
          ...baseWorkspace,
          liveWorkspaceId: "missing",
          metadata: {
            worktree: {
              checkoutPath: "/repo",
              isLinkedWorktree: false,
              repoKey: "r",
              repoName: "r",
              repoRoot: "/repo",
            },
          },
        },
        snapshot: {
          agents: [],
          panes: [],
          tabs: [],
          workspaces: [{ id: "w2", worktree: { checkout_path: "/repo" } }],
        },
      }),
    ).toMatchObject({ liveWorkspaceId: "w2", status: "active" });
  });

  test("startup re-resolution falls back to a unique label", () => {
    expect(
      resolveObservedWorkspaceFromSnapshot({
        observedWorkspace: {
          ...baseWorkspace,
          liveWorkspaceId: "missing",
          metadata: { label: "Repo" },
        },
        snapshot: {
          agents: [],
          panes: [],
          tabs: [],
          workspaces: [{ id: "w2", label: "Repo" }],
        },
      }),
    ).toMatchObject({ liveWorkspaceId: "w2", status: "active" });
  });

  test("startup re-resolution returns ambiguous when multiple labels match", () => {
    expect(
      resolveObservedWorkspaceFromSnapshot({
        observedWorkspace: {
          ...baseWorkspace,
          liveWorkspaceId: "missing",
          metadata: { label: "Repo" },
        },
        snapshot: {
          agents: [],
          panes: [],
          tabs: [],
          workspaces: [
            { id: "w2", label: "Repo" },
            { id: "w3", label: "Repo" },
          ],
        },
      }),
    ).toMatchObject({ liveWorkspaceId: null, status: "ambiguous" });
  });

  test("startup re-resolution returns missing when nothing matches", () => {
    expect(
      resolveObservedWorkspaceFromSnapshot({
        observedWorkspace: {
          ...baseWorkspace,
          liveWorkspaceId: "missing",
          metadata: { label: "Repo" },
        },
        snapshot: { agents: [], panes: [], tabs: [], workspaces: [{ id: "w2", label: "Other" }] },
      }),
    ).toMatchObject({ liveWorkspaceId: null, status: "missing" });
  });
});

function fakeObservedWorkspaces(onMarkResolution: (input: unknown) => void = () => undefined) {
  return { markResolution: onMarkResolution };
}

function fakeWorkers() {
  return { listForWorkspace: () => [], updateLiveIdentity: () => undefined };
}
