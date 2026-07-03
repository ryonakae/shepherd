import { afterEach, describe, expect, test } from "vitest";
import { NotificationService } from "@/observability/notification-service.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

describe("NotificationService", () => {
  test("subscribes, delivers, acks, hidden context, and auto-resume monotonically", () => {
    const { cursors, sqlite, workerEvents, workspaces } = openObservabilityDbHarness();
    const service = new NotificationService({ cursors, workerEvents });
    const workspace = workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });
    const subscription = service.subscribe({
      autoResume: true,
      observedWorkspaceId: workspace.id,
      subscriberId: "pi-extension",
      subscriberKind: "pi",
    });
    const reused = service.subscribe({
      autoResume: true,
      observedWorkspaceId: workspace.id,
      subscriberId: "pi-extension",
      subscriberKind: "pi",
    });
    expect(reused.id).toBe(subscription.id);

    const first = workerEvents.append({
      observedWorkspaceId: workspace.id,
      payload: { status: "blocked" },
      type: "worker.blocked",
      workerId: null,
    });
    const second = workerEvents.append({
      observedWorkspaceId: workspace.id,
      payload: { status: "done" },
      type: "worker.completed",
      workerId: null,
    });

    expect(service.pending({ subscriptionId: subscription.id })).toEqual([first, second]);
    service.markDelivered({ eventId: second.id, subscriptionId: subscription.id });
    expect(cursors.getCursor(subscription.id)).toMatchObject({
      ackedEventId: 0,
      deliveredEventId: second.id,
    });

    expect(service.nextHiddenContextEvents({ limit: 10, subscriptionId: subscription.id })).toEqual(
      [first, second],
    );
    service.markHiddenContextInjected({ eventId: first.id, subscriptionId: subscription.id });
    expect(service.nextHiddenContextEvents({ limit: 10, subscriptionId: subscription.id })).toEqual(
      [second],
    );

    expect(service.nextAutoResumeEvent({ subscriptionId: subscription.id })).toEqual(first);
    service.markAutoResumed({ eventId: first.id, subscriptionId: subscription.id });
    expect(service.nextAutoResumeEvent({ subscriptionId: subscription.id })).toEqual(second);

    service.ack({ eventId: second.id, subscriptionId: subscription.id });
    service.ack({ eventId: first.id, subscriptionId: subscription.id });
    expect(cursors.getCursor(subscription.id)).toMatchObject({
      ackedEventId: second.id,
      deliveredEventId: second.id,
    });
    expect(service.pending({ subscriptionId: subscription.id })).toEqual([]);

    sqlite.close();
  });

  test("auto-resume is disabled per subscription", () => {
    const { cursors, sqlite, workerEvents, workspaces } = openObservabilityDbHarness();
    const service = new NotificationService({ cursors, workerEvents });
    const workspace = workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });
    const subscription = service.subscribe({
      autoResume: false,
      observedWorkspaceId: workspace.id,
      subscriberId: "tui",
      subscriberKind: "tui",
    });
    workerEvents.append({
      observedWorkspaceId: workspace.id,
      payload: {},
      type: "worker.blocked",
      workerId: null,
    });

    expect(service.nextAutoResumeEvent({ subscriptionId: subscription.id })).toBeUndefined();
    sqlite.close();
  });
});
