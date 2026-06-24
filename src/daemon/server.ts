import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type ConfigLoadResult, loadShepherdConfig } from "@/config/load.js";
import type { EventRecord, EventStore } from "@/db/event-store.js";
import type { SessionSummaryStore } from "@/db/session-summary.js";
import { buildGatewayMessagesFromEvents } from "@/gateway/context.js";
import type { GatewayMessage, GatewayRunner } from "@/gateway/runner.js";
import { toHerdrProgressSignal } from "@/herdr/progress.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";

type ShepherdDaemonServerOptions = {
  configPath?: string;
  deliveryFanout?: EventDeliveryFanout;
  gatewayRunner?: GatewayTurnRunner;
  socketPath: string;
  store: EventStore;
  summaries?: Pick<SessionSummaryStore, "getSummary">;
};

type EventDeliveryFanout = {
  deliverEvent(event: EventRecord): Promise<unknown>;
};

type GatewayTurnRunner = Pick<GatewayRunner, "runTurn">;

type RpcRequest = {
  id?: string | number;
  method?: string;
  params?: unknown;
};

type EventWireRecord = Omit<EventRecord, "createdAt"> & {
  createdAt: string;
};

type ActorPresentationInput = {
  avatarUrl?: string;
  displayName?: string;
  sourcePlatform?: string;
  sourceUserId?: string;
};

export type ReceiveUserMessageInput = {
  actorId?: string;
  idempotencyKey?: string;
  presentation?: unknown;
  sessionId: string;
  text: string;
};

export type ReceiveApprovalRequestInput = {
  approvalId: string;
  provider: string;
  request: unknown;
  sessionId: string;
  text?: string;
};

export type ReceiveApprovalResponseInput = {
  approvalId: string;
  decision: "approved" | "denied";
  reason?: string;
  responderActorId?: string;
  sessionId: string;
};

export type ReceiveHerdrProgressInput = {
  herdrSessionName: string;
  rawEvent: unknown;
  sessionId: string;
  workspaceId?: string;
};

export class ShepherdDaemonServer {
  readonly #configPath: string | undefined;
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #deliveryFanout: EventDeliveryFanout | undefined;
  readonly #gatewayRunner: GatewayTurnRunner | undefined;
  readonly #store: EventStore;
  readonly #summaries: Pick<SessionSummaryStore, "getSummary"> | undefined;
  readonly #subscriptions = new Map<string, Set<Socket>>();
  #config: ConfigLoadResult | undefined;

  constructor(options: ShepherdDaemonServerOptions) {
    this.#configPath = options.configPath;
    this.#deliveryFanout = options.deliveryFanout;
    this.#gatewayRunner = options.gatewayRunner;
    this.#socketPath = options.socketPath;
    this.#store = options.store;
    this.#summaries = options.summaries;
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

  stop(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    this.#subscriptions.clear();

    return new Promise((resolve, reject) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }

      this.#server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async receiveUserMessage(input: ReceiveUserMessageInput): Promise<{
    event: EventRecord;
    gatewayEvents: EventRecord[];
  }> {
    const event = this.#storeUserMessage(input);
    await this.#publishEvent(event);
    const gatewayEvents = await this.#wakeGatewayForUserMessage(input, event);

    return { event, gatewayEvents };
  }

  async receiveApprovalRequest(input: ReceiveApprovalRequestInput): Promise<{
    event: EventRecord;
  }> {
    const event = this.#store.appendEvent({
      idempotencyKey: `approval:${input.approvalId}:requested`,
      payload: {
        approvalId: input.approvalId,
        provider: input.provider,
        request: input.request,
        text: input.text ?? `Approval requested by ${input.provider}: ${input.approvalId}`,
      },
      sessionId: input.sessionId,
      type: "approval.requested",
    });
    await this.#publishEvent(event);

    return { event };
  }

  async receiveApprovalResponse(input: ReceiveApprovalResponseInput): Promise<{
    event: EventRecord;
  }> {
    if (input.responderActorId) {
      this.#store.upsertActor({
        displayName: input.responderActorId,
        id: input.responderActorId,
        kind: "user",
        presentation: {},
      });
    }

    const event = this.#store.appendEvent({
      idempotencyKey: `approval:${input.approvalId}:response`,
      payload: {
        approvalId: input.approvalId,
        decision: input.decision,
        text: `Approval ${input.decision}: ${input.approvalId}`,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      sessionId: input.sessionId,
      type: "approval.responded",
      ...(input.responderActorId ? { actorId: input.responderActorId } : {}),
    });
    await this.#publishEvent(event);

    return { event };
  }

  async receiveHerdrProgress(input: ReceiveHerdrProgressInput): Promise<{
    event: EventRecord;
  }> {
    const payload = toHerdrProgressSignal(input.rawEvent, {
      herdrSessionName: input.herdrSessionName,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    });
    const idempotencyKey = payload.eventId
      ? `herdr:${input.herdrSessionName}:event:${payload.eventId}`
      : undefined;
    const event = this.#store.appendEvent({
      payload,
      sessionId: input.sessionId,
      type: "herdr.progress",
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    await this.#publishEvent(event);

    return { event };
  }

  #storeUserMessage(input: ReceiveUserMessageInput): EventRecord {
    if (input.actorId) {
      const presentation = parseActorPresentation(input.presentation);
      this.#store.upsertActor({
        displayName: presentation.displayName ?? input.actorId,
        id: input.actorId,
        kind: "user",
        presentation: input.presentation ?? {},
        ...(presentation.avatarUrl ? { avatarUrl: presentation.avatarUrl } : {}),
        ...(presentation.sourcePlatform ? { sourcePlatform: presentation.sourcePlatform } : {}),
        ...(presentation.sourceUserId ? { sourceUserId: presentation.sourceUserId } : {}),
      });
    }

    return this.#store.appendEvent({
      payload: {
        presentation: input.presentation ?? {},
        text: input.text,
      },
      sessionId: input.sessionId,
      type: "user.message",
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  async #wakeGatewayForUserMessage(
    input: ReceiveUserMessageInput,
    event: EventRecord,
  ): Promise<EventRecord[]> {
    if (!this.#gatewayRunner) {
      return [];
    }

    const summary = this.#summaries?.getSummary(input.sessionId)?.content;
    const result = await this.#collectGatewayTurnResult(
      input.sessionId,
      event.id,
      buildGatewayMessagesFromEvents(
        this.#store.listRecentEvents(input.sessionId, 40),
        summary ? { summary } : {},
      ),
    );
    for (const gatewayEvent of result.events) {
      await this.#publishEvent(gatewayEvent);
    }

    return result.events;
  }

  #handleConnection(socket: Socket): void {
    const decoder = new JsonLineDecoder();
    this.#sockets.add(socket);

    socket.on("data", (chunk) => {
      try {
        for (const message of decoder.push(chunk.toString("utf8"))) {
          this.#handleMessage(socket, message);
        }
      } catch (error) {
        this.#write(socket, {
          error: { message: error instanceof Error ? error.message : "Invalid JSON frame" },
        });
      }
    });

    socket.on("close", () => this.#removeSocket(socket));
    socket.on("error", () => this.#removeSocket(socket));
  }

  #handleMessage(socket: Socket, message: unknown): void {
    const request = message as RpcRequest;

    if (request.method === "session.subscribe") {
      this.#subscribe(socket, request);
      return;
    }

    if (request.method === "session.append_event") {
      void this.#appendEvent(socket, request);
      return;
    }

    if (request.method === "session.user_message") {
      void this.#appendUserMessage(socket, request);
      return;
    }

    if (request.method === "session.rename") {
      this.#renameSession(socket, request);
      return;
    }

    if (request.method === "approval.request") {
      void this.#requestApproval(socket, request);
      return;
    }

    if (request.method === "approval.respond") {
      void this.#respondApproval(socket, request);
      return;
    }

    if (request.method === "herdr.progress") {
      void this.#recordHerdrProgress(socket, request);
      return;
    }

    if (request.method === "config.reload") {
      this.#reloadConfig(socket, request);
      return;
    }

    if (request.method === "gateway.run_turn") {
      void this.#runGatewayTurn(socket, request);
      return;
    }

    this.#write(socket, {
      error: { message: `Unknown method: ${String(request.method)}` },
      id: request.id,
    });
  }

  #subscribe(socket: Socket, request: RpcRequest): void {
    const params = request.params as { afterEventId?: number; sessionId?: string };
    if (!params?.sessionId) {
      this.#write(socket, { error: { message: "sessionId is required" }, id: request.id });
      return;
    }

    const replay = this.#store.listEvents(params.sessionId, params.afterEventId ?? 0);
    const subscribers = this.#subscriptions.get(params.sessionId) ?? new Set<Socket>();
    subscribers.add(socket);
    this.#subscriptions.set(params.sessionId, subscribers);

    this.#write(socket, {
      id: request.id,
      result: { replayed: replay.length, subscribed: true },
    });

    for (const event of replay) {
      this.#writeEvent(socket, event);
    }
  }

  async #appendEvent(socket: Socket, request: RpcRequest): Promise<void> {
    const params = request.params as {
      actorId?: string;
      idempotencyKey?: string;
      payload?: unknown;
      sessionId?: string;
      type?: string;
    };

    if (!params?.sessionId || !params.type) {
      this.#write(socket, {
        error: { message: "sessionId and type are required" },
        id: request.id,
      });
      return;
    }

    const appendInput = {
      payload: params.payload ?? {},
      sessionId: params.sessionId,
      type: params.type,
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    };

    const event = this.#store.appendEvent(appendInput);

    this.#write(socket, {
      id: request.id,
      result: { event: toWireEvent(event) },
    });
    await this.#publishEvent(event);
  }

  async #appendUserMessage(socket: Socket, request: RpcRequest): Promise<void> {
    const params = request.params as {
      actorId?: string;
      idempotencyKey?: string;
      presentation?: unknown;
      sessionId?: string;
      text?: string;
    };

    if (!params?.sessionId || !params.text) {
      this.#write(socket, {
        error: { message: "sessionId and text are required" },
        id: request.id,
      });
      return;
    }

    const input = {
      sessionId: params.sessionId,
      text: params.text,
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.presentation !== undefined ? { presentation: params.presentation } : {}),
    };
    const event = this.#storeUserMessage(input);

    this.#write(socket, {
      id: request.id,
      result: { event: toWireEvent(event) },
    });
    await this.#publishEvent(event);
    await this.#wakeGatewayForUserMessage(input, event);
  }

  #renameSession(socket: Socket, request: RpcRequest): void {
    const params = request.params as { sessionId?: string; title?: string | null };
    if (!params?.sessionId || params.title === undefined) {
      this.#write(socket, {
        error: { message: "sessionId and title are required" },
        id: request.id,
      });
      return;
    }

    const session = this.#store.updateSessionTitle(params.sessionId, params.title);
    const event = this.#store.appendEvent({
      payload: { title: params.title },
      sessionId: params.sessionId,
      type: "session.renamed",
    });

    this.#write(socket, {
      id: request.id,
      result: { session: toWireSession(session) },
    });
    void this.#publishEvent(event);
  }

  async #requestApproval(socket: Socket, request: RpcRequest): Promise<void> {
    const params = request.params as {
      approvalId?: string;
      provider?: string;
      request?: unknown;
      sessionId?: string;
      text?: string;
    };
    if (!params?.sessionId || !params.approvalId || !params.provider) {
      this.#write(socket, {
        error: { message: "sessionId, approvalId, and provider are required" },
        id: request.id,
      });
      return;
    }

    const result = await this.receiveApprovalRequest({
      approvalId: params.approvalId,
      provider: params.provider,
      request: params.request ?? {},
      sessionId: params.sessionId,
      ...(params.text ? { text: params.text } : {}),
    });
    this.#write(socket, {
      id: request.id,
      result: { event: toWireEvent(result.event) },
    });
  }

  async #respondApproval(socket: Socket, request: RpcRequest): Promise<void> {
    const params = request.params as {
      approvalId?: string;
      decision?: string;
      reason?: string;
      responderActorId?: string;
      sessionId?: string;
    };
    if (
      !params?.sessionId ||
      !params.approvalId ||
      (params.decision !== "approved" && params.decision !== "denied")
    ) {
      this.#write(socket, {
        error: { message: "sessionId, approvalId, and decision are required" },
        id: request.id,
      });
      return;
    }

    const result = await this.receiveApprovalResponse({
      approvalId: params.approvalId,
      decision: params.decision,
      sessionId: params.sessionId,
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.responderActorId ? { responderActorId: params.responderActorId } : {}),
    });
    this.#write(socket, {
      id: request.id,
      result: { event: toWireEvent(result.event) },
    });
  }

  async #recordHerdrProgress(socket: Socket, request: RpcRequest): Promise<void> {
    const params = request.params as {
      herdrSessionName?: string;
      rawEvent?: unknown;
      sessionId?: string;
      workspaceId?: string;
    };
    if (!params?.sessionId || !params.herdrSessionName || params.rawEvent === undefined) {
      this.#write(socket, {
        error: { message: "sessionId, herdrSessionName, and rawEvent are required" },
        id: request.id,
      });
      return;
    }

    const result = await this.receiveHerdrProgress({
      herdrSessionName: params.herdrSessionName,
      rawEvent: params.rawEvent,
      sessionId: params.sessionId,
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
    });
    this.#write(socket, {
      id: request.id,
      result: { event: toWireEvent(result.event) },
    });
  }

  #reloadConfig(socket: Socket, request: RpcRequest): void {
    if (!this.#configPath) {
      this.#write(socket, {
        error: { message: "No config path configured" },
        id: request.id,
      });
      return;
    }

    this.#config = loadShepherdConfig(this.#configPath);
    this.#write(socket, {
      id: request.id,
      result: { ok: this.#config.ok },
    });
  }

  async #runGatewayTurn(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#gatewayRunner) {
      this.#write(socket, {
        error: { message: "Gateway runner is not configured" },
        id: request.id,
      });
      return;
    }

    const params = request.params as { messages?: unknown; sessionId?: string };
    if (!params?.sessionId || !isGatewayMessages(params.messages)) {
      this.#write(socket, {
        error: { message: "sessionId and messages are required" },
        id: request.id,
      });
      return;
    }

    try {
      const result = await this.#collectGatewayTurnResult(
        params.sessionId,
        undefined,
        params.messages,
      );
      this.#write(socket, {
        id: request.id,
        result: result.output,
      });
      for (const event of result.events) {
        await this.#publishEvent(event);
      }
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #collectGatewayTurnResult(
    sessionId: string,
    triggeringEventId: number | undefined,
    messages: GatewayMessage[],
  ): Promise<{ events: EventRecord[]; output: { text: string } }> {
    if (!this.#gatewayRunner) {
      throw new Error("Gateway runner is not configured");
    }

    const afterEventId = this.#store.getLatestEventId(sessionId);
    const output = await this.#gatewayRunner.runTurn({
      messages,
      sessionId,
      ...(triggeringEventId !== undefined ? { triggeringEventId } : {}),
    });
    const events = this.#store.listEvents(sessionId, afterEventId, 500);

    return { events, output };
  }

  #broadcastEvent(event: EventRecord): void {
    for (const socket of this.#subscriptions.get(event.sessionId) ?? []) {
      this.#writeEvent(socket, event);
    }
  }

  async #publishEvent(event: EventRecord): Promise<void> {
    this.#broadcastEvent(event);
    await this.#deliveryFanout?.deliverEvent(event);
  }

  #writeEvent(socket: Socket, event: EventRecord): void {
    this.#write(socket, {
      method: "session.event",
      params: { event: toWireEvent(event) },
    });
  }

  #write(socket: Socket, message: unknown): void {
    socket.write(encodeJsonLine(message));
  }

  #removeSocket(socket: Socket): void {
    this.#sockets.delete(socket);
    for (const subscribers of this.#subscriptions.values()) {
      subscribers.delete(socket);
    }
  }
}

function isGatewayMessages(value: unknown): value is GatewayMessage[] {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      typeof (message as GatewayMessage).content === "string" &&
      ["assistant", "system", "user"].includes((message as GatewayMessage).role),
  );
}

function parseActorPresentation(value: unknown): ActorPresentationInput {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.avatarUrl === "string" ? { avatarUrl: record.avatarUrl } : {}),
    ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
    ...(typeof record.sourcePlatform === "string" ? { sourcePlatform: record.sourcePlatform } : {}),
    ...(typeof record.sourceUserId === "string" ? { sourceUserId: record.sourceUserId } : {}),
  };
}

function toWireEvent(event: EventRecord): EventWireRecord {
  return {
    ...event,
    createdAt: event.createdAt.toISOString(),
  };
}

function toWireSession(session: ReturnType<EventStore["getSession"]>): Omit<
  typeof session,
  "createdAt" | "updatedAt"
> & {
  createdAt: string;
  updatedAt: string;
} {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}
