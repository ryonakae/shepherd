import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { Value } from "@sinclair/typebox/value";
import type { ObservedWorkspaceStore } from "@/db/observed-workspaces.js";
import type { WorkerEventStore } from "@/db/worker-events.js";
import type { WorkerSnapshotStore } from "@/db/worker-snapshots.js";
import type { WorkerStore } from "@/db/workers.js";
import { encodeJsonLine, JsonLineDecoder } from "@/gateway/json-lines.js";
import type { NotificationService } from "@/observability/notification-service.js";
import {
  notificationAckInputSchema,
  notificationSubscribeInputSchema,
  observeWorkspaceInputSchema,
  runtimeTelemetryInputSchema,
  workerEventsInputSchema,
  workerMessageInputSchema,
  workerStartInputSchema,
  workerWaitStateInputSchema,
  workspaceSnapshotInputSchema,
} from "@/observability/schemas.js";
import type { WorkerStatePipeline } from "@/observability/worker-state-pipeline.js";

type RpcRequest = { id?: number | string; method?: string; params?: unknown };

type ObservabilityStores = {
  observedWorkspaces: ObservedWorkspaceStore;
  snapshots: WorkerSnapshotStore;
  workerEvents: WorkerEventStore;
  workers: WorkerStore;
};

export class ObservabilityRpcServer {
  readonly #notifications: NotificationService;
  readonly #pipeline: WorkerStatePipeline;
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #stores: ObservabilityStores;

  constructor(options: {
    notifications: NotificationService;
    pipeline: WorkerStatePipeline;
    socketPath: string;
    stores: ObservabilityStores;
  }) {
    this.#notifications = options.notifications;
    this.#pipeline = options.pipeline;
    this.#socketPath = options.socketPath;
    this.#stores = options.stores;
    this.#server = createServer((socket) => this.#handleConnection(socket));
  }

  start(): Promise<void> {
    if (existsSync(this.#socketPath)) {
      unlinkSync(this.#socketPath);
    }
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
    if (existsSync(this.#socketPath)) {
      unlinkSync(this.#socketPath);
    }
  }

  publishWorkerEvent(input: { observedWorkspaceId: string }): void {
    const event = this.#stores.workerEvents.listAfter({
      afterEventId: Math.max(
        0,
        this.#stores.workerEvents.latestEventId(input.observedWorkspaceId) - 1,
      ),
      limit: 1,
      observedWorkspaceId: input.observedWorkspaceId,
    })[0];
    if (!event) {
      return;
    }
    for (const socket of this.#sockets) {
      socket.write(encodeJsonLine({ method: "worker.event", params: { event } }));
    }
  }

  #handleConnection(socket: Socket): void {
    this.#sockets.add(socket);
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk.toString("utf8"))) {
        void this.#handleRequest(socket, message as RpcRequest);
      }
    });
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => this.#sockets.delete(socket));
  }

  async #handleRequest(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      if (!request.method) {
        throw new Error("Missing method");
      }
      const result = await this.#dispatch(request.method, request.params ?? {});
      socket.write(encodeJsonLine({ id: request.id, result }));
    } catch (error) {
      socket.write(
        encodeJsonLine({
          error: { message: error instanceof Error ? error.message : String(error) },
          id: request.id,
        }),
      );
    }
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "workspace.observe": {
        assertSchema(observeWorkspaceInputSchema, params);
        const input = params as {
          herdrSessionName?: string;
          label?: string;
          socketPath?: string;
          workspaceId: string;
        };
        const observedWorkspace = this.#stores.observedWorkspaces.observe({
          ...(input.herdrSessionName ? { herdrSessionName: input.herdrSessionName } : {}),
          metadata: input.label ? { label: input.label } : {},
          ...(input.socketPath ? { socketPath: input.socketPath } : {}),
          workspaceId: input.workspaceId,
        });
        return { observedWorkspace };
      }
      case "workspace.snapshot": {
        assertSchema(workspaceSnapshotInputSchema, params);
        const input = params as { observedWorkspaceId: string };
        await this.#pipeline.refreshWorkspace(input.observedWorkspaceId);
        return { workers: this.#stores.snapshots.listCurrent(input.observedWorkspaceId) };
      }
      case "worker.events": {
        assertSchema(workerEventsInputSchema, params);
        const input = params as {
          afterEventId?: number;
          limit?: number;
          observedWorkspaceId: string;
        };
        return { events: this.#stores.workerEvents.listAfter(input) };
      }
      case "runtime.telemetry": {
        assertSchema(runtimeTelemetryInputSchema, params);
        const input = params as Parameters<WorkerStatePipeline["handleTelemetry"]>[0];
        await this.#pipeline.handleTelemetry(input);
        return { accepted: true };
      }
      case "notification.subscribe": {
        assertSchema(notificationSubscribeInputSchema, params);
        const input = params as {
          autoResume?: boolean;
          observedWorkspaceId: string;
          subscriberId: string;
          subscriberKind: string;
        };
        const subscription = this.#notifications.subscribe({
          ...input,
          autoResume: input.autoResume ?? false,
        });
        return {
          events: this.#notifications.pending({ subscriptionId: subscription.id }),
          subscription,
        };
      }
      case "notification.ack": {
        assertSchema(notificationAckInputSchema, params);
        this.#notifications.ack(params as { eventId: number; subscriptionId: string });
        return { acknowledged: true };
      }
      case "worker.message":
        assertSchema(workerMessageInputSchema, params);
        return { accepted: true };
      case "worker.wait_state":
        assertSchema(workerWaitStateInputSchema, params);
        return { matched: false };
      case "worker.start":
        assertSchema(workerStartInputSchema, params);
        return { started: true };
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}

function assertSchema(schema: Parameters<typeof Value.Check>[0], value: unknown): void {
  if (!Value.Check(schema, value)) {
    throw new Error("Invalid RPC params");
  }
}
