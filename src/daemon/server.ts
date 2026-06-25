import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type ConfigLoadResult, loadShepherdConfig } from "@/config/load.js";
import type { EventRecord, EventStore } from "@/db/event-store.js";
import type { SessionSummaryStore } from "@/db/session-summary.js";
import { buildGatewayMessagesFromEvents } from "@/gateway/context.js";
import type { ExternalGatewayRunQueue } from "@/gateway/external-run-queue.js";
import {
  type ProviderOverrideResolver,
  parseGatewayProviderOverride,
} from "@/gateway/provider-overrides.js";
import type { GatewayMessage, GatewayRunner } from "@/gateway/runner.js";
import type { LogicalToolRunner } from "@/gateway/tools.js";
import { toHerdrProgressSignal } from "@/herdr/progress.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";

type ShepherdDaemonServerOptions = {
  configPath?: string;
  deliveryFanout?: EventDeliveryFanout;
  gatewayRunner?: GatewayTurnRunner;
  gatewayRuns?: ExternalGatewayRunQueue;
  headlessPi?: HeadlessPiSupervisorService;
  logicalTools?: LogicalToolService;
  providerOverrides?: ProviderOverrideResolver;
  streamDelivery?: GatewayStreamDeliveryService;
  socketPath: string;
  store: EventStore;
  summaries?: Pick<SessionSummaryStore, "getSummary">;
};

type EventDeliveryFanout = {
  deliverEvent(event: EventRecord): Promise<unknown>;
};

type GatewayTurnRunner = Pick<GatewayRunner, "runTurn">;

type HeadlessPiSupervisorService = {
  ensureStarted(input: { piSessionFile: string; sessionId: string }): unknown;
};

type LogicalToolService = Pick<LogicalToolRunner, "list" | "run">;

type GatewayStreamDeliveryService = {
  delta(input: { delta: string; gatewayRunId: string; sessionId: string }): Promise<void>;
  finish(input: { finalText?: string; gatewayRunId: string }): Promise<void>;
  hasFinished(gatewayRunId: string): boolean;
};

type RpcRequest = {
  id?: string | number;
  method?: string;
  params?: unknown;
};

type EventWireRecord = Omit<EventRecord, "createdAt"> & {
  createdAt: string;
};

export type PiOwnerKind = "headless_pi" | "tui_pi";

export type PiHandshakeRecord = {
  attached: boolean;
  daemonId: string;
  extensionVersion: string;
  mode: "json" | "print" | "rpc" | "tui";
  ownerId: string;
  ownerKind: PiOwnerKind;
  piSessionFile?: string;
  piSessionId?: string;
  sessionId?: string;
};

type PiOwnerRecord = {
  lastHeartbeatAt: Date;
  ownerId: string;
  ownerKind: PiOwnerKind;
  sessionId: string;
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
  providerOverride?: unknown;
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
  readonly #gatewayRuns: ExternalGatewayRunQueue | undefined;
  readonly #headlessPi: HeadlessPiSupervisorService | undefined;
  readonly #logicalTools: LogicalToolService | undefined;
  readonly #piHandshakeWaiters: Array<(handshake: PiHandshakeRecord) => void> = [];
  readonly #piOwners = new Map<string, PiOwnerRecord>();
  readonly #providerOverrides: ProviderOverrideResolver | undefined;
  readonly #store: EventStore;
  readonly #streamDelivery: GatewayStreamDeliveryService | undefined;
  readonly #summaries: Pick<SessionSummaryStore, "getSummary"> | undefined;
  readonly #subscriptions = new Map<string, Set<Socket>>();
  #config: ConfigLoadResult | undefined;
  #lastPiHandshake: PiHandshakeRecord | undefined;

  constructor(options: ShepherdDaemonServerOptions) {
    this.#configPath = options.configPath;
    this.#deliveryFanout = options.deliveryFanout;
    this.#gatewayRunner = options.gatewayRunner;
    this.#gatewayRuns = options.gatewayRuns;
    this.#headlessPi = options.headlessPi;
    this.#logicalTools = options.logicalTools;
    this.#providerOverrides = options.providerOverrides;
    this.#socketPath = options.socketPath;
    this.#store = options.store;
    this.#streamDelivery = options.streamDelivery;
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

  waitForPiHandshake(options: { timeoutMs: number }): Promise<PiHandshakeRecord> {
    if (this.#lastPiHandshake) {
      return Promise.resolve(this.#lastPiHandshake);
    }

    return new Promise((resolve, reject) => {
      const waiter = (handshake: PiHandshakeRecord) => {
        clearTimeout(timeout);
        resolve(handshake);
      };
      const timeout = setTimeout(() => {
        const index = this.#piHandshakeWaiters.indexOf(waiter);
        if (index >= 0) {
          this.#piHandshakeWaiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for pi.handshake after ${options.timeoutMs}ms`));
      }, options.timeoutMs);

      this.#piHandshakeWaiters.push(waiter);
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
        ...(input.providerOverride !== undefined
          ? { providerOverride: input.providerOverride }
          : {}),
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
    if (this.#gatewayRuns) {
      const result = this.#gatewayRuns.queueRun({
        sessionId: input.sessionId,
        triggeringEventId: event.id,
      });
      await this.#publishEvent(result.event);
      this.#startHeadlessPiForQueuedRun(input.sessionId, result.event);
      return [result.event];
    }

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
      parseGatewayProviderOverride(input.providerOverride),
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

    if (request.method === "session.create") {
      this.#createSession(socket, request);
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

    if (request.method === "pi.handshake") {
      this.#recordPiHandshake(socket, request);
      return;
    }

    if (request.method === "pi.attach") {
      this.#attachPiSession(socket, request);
      return;
    }

    if (request.method === "pi.heartbeat") {
      this.#recordPiHeartbeat(socket, request);
      return;
    }

    if (request.method === "gateway.run_turn") {
      void this.#runGatewayTurn(socket, request);
      return;
    }

    if (request.method === "gateway.claim_next_run") {
      void this.#claimNextGatewayRun(socket, request);
      return;
    }

    if (request.method === "gateway.start_run") {
      void this.#startGatewayRun(socket, request);
      return;
    }

    if (request.method === "gateway.complete_run") {
      void this.#completeGatewayRun(socket, request);
      return;
    }

    if (request.method === "gateway.stream_delta") {
      void this.#streamGatewayDelta(socket, request);
      return;
    }

    if (request.method === "gateway.stream_finish") {
      void this.#finishGatewayStream(socket, request);
      return;
    }

    if (request.method === "gateway.fail_run") {
      void this.#failGatewayRun(socket, request);
      return;
    }

    if (request.method === "tool.list") {
      this.#listTools(socket, request);
      return;
    }

    if (request.method === "tool.run") {
      void this.#runTool(socket, request);
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

  #createSession(socket: Socket, request: RpcRequest): void {
    const params = request.params as {
      slackAutoBind?: { channelId?: unknown };
      title?: unknown;
      workingContextId?: unknown;
    };
    const channelId = params?.slackAutoBind?.channelId;

    if (params?.slackAutoBind !== undefined && typeof channelId !== "string") {
      this.#write(socket, {
        error: { message: "slackAutoBind.channelId must be a string" },
        id: request.id,
      });
      return;
    }

    const session = this.#store.createSession({
      ...(typeof params?.title === "string" ? { title: params.title } : {}),
      ...(typeof params?.workingContextId === "string"
        ? { workingContextId: params.workingContextId }
        : {}),
      ...(typeof channelId === "string"
        ? { metadata: { slackAutoBind: { channelId, status: "pending" } } }
        : {}),
    });

    this.#write(socket, {
      id: request.id,
      result: { session: toWireSession(session) },
    });
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
      providerOverride?: unknown;
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
      ...(params.providerOverride !== undefined
        ? { providerOverride: params.providerOverride }
        : {}),
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

  #startHeadlessPiForQueuedRun(sessionId: string, event: EventRecord): void {
    if (!this.#headlessPi) {
      return;
    }

    const piSessionFile = getQueuedRunPiSessionFile(event.payload);
    if (!piSessionFile) {
      return;
    }

    this.#headlessPi.ensureStarted({ piSessionFile, sessionId });
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

  #recordPiHandshake(socket: Socket, request: RpcRequest): void {
    const params = request.params as {
      binding?: { sessionId?: unknown };
      extensionVersion?: unknown;
      mode?: unknown;
      piSessionFile?: unknown;
      piSessionId?: unknown;
    };
    if (typeof params?.extensionVersion !== "string" || !isPiMode(params.mode)) {
      this.#write(socket, {
        error: { message: "extensionVersion and mode are required" },
        id: request.id,
      });
      return;
    }

    const sessionId =
      typeof params.binding?.sessionId === "string" ? params.binding.sessionId : undefined;
    const ownerKind = piOwnerKindForMode(params.mode);
    const handshake: PiHandshakeRecord = {
      attached: sessionId !== undefined,
      daemonId: "default",
      extensionVersion: params.extensionVersion,
      mode: params.mode,
      ownerId: randomUUID(),
      ownerKind,
      ...(typeof params.piSessionFile === "string" ? { piSessionFile: params.piSessionFile } : {}),
      ...(typeof params.piSessionId === "string" ? { piSessionId: params.piSessionId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    this.#lastPiHandshake = handshake;
    if (sessionId !== undefined) {
      this.#piOwners.set(handshake.ownerId, {
        lastHeartbeatAt: new Date(),
        ownerId: handshake.ownerId,
        ownerKind,
        sessionId,
      });
    }

    for (const resolve of this.#piHandshakeWaiters.splice(0)) {
      resolve(handshake);
    }

    this.#write(socket, {
      id: request.id,
      result: {
        attached: handshake.attached,
        daemonId: handshake.daemonId,
        ownerId: handshake.ownerId,
        ownerKind: handshake.ownerKind,
        ...(handshake.sessionId !== undefined ? { sessionId: handshake.sessionId } : {}),
      },
    });
  }

  #attachPiSession(socket: Socket, request: RpcRequest): void {
    const params = request.params as {
      force?: unknown;
      mode?: unknown;
      piSessionFile?: unknown;
      piSessionId?: unknown;
      sessionId?: unknown;
    };
    if (
      typeof params?.sessionId !== "string" ||
      typeof params.piSessionFile !== "string" ||
      typeof params.piSessionId !== "string" ||
      !isPiMode(params.mode)
    ) {
      this.#write(socket, {
        error: { message: "sessionId, piSessionFile, piSessionId, and mode are required" },
        id: request.id,
      });
      return;
    }

    const session = this.#store.getSession(params.sessionId);
    const existingPi = session.metadata.pi;
    if (existingPi && existingPi.sessionFile !== params.piSessionFile && params.force !== true) {
      this.#write(socket, {
        error: { message: "Session is already attached to a different Pi session" },
        id: request.id,
      });
      return;
    }

    const now = new Date();
    const updated = this.#store.updateSessionMetadata(params.sessionId, {
      ...session.metadata,
      pi: {
        createdAt: existingPi?.createdAt ?? now.toISOString(),
        sessionFile: params.piSessionFile,
        sessionId: params.piSessionId,
        updatedAt: now.toISOString(),
      },
    });
    const ownerId = randomUUID();
    const ownerKind = piOwnerKindForMode(params.mode);
    this.#piOwners.set(ownerId, {
      lastHeartbeatAt: now,
      ownerId,
      ownerKind,
      sessionId: params.sessionId,
    });

    this.#write(socket, {
      id: request.id,
      result: {
        daemonId: "default",
        ownerId,
        ownerKind,
        session: toWireSession(updated),
        socketPath: this.#socketPath,
      },
    });
  }

  #recordPiHeartbeat(socket: Socket, request: RpcRequest): void {
    const params = request.params as { ownerId?: unknown; sessionId?: unknown };
    if (typeof params?.ownerId !== "string" || typeof params.sessionId !== "string") {
      this.#write(socket, {
        error: { message: "ownerId and sessionId are required" },
        id: request.id,
      });
      return;
    }

    const owner = this.#piOwners.get(params.ownerId);
    if (!owner || owner.sessionId !== params.sessionId) {
      this.#write(socket, {
        error: { message: "Pi owner is not attached to this session" },
        id: request.id,
      });
      return;
    }

    owner.lastHeartbeatAt = new Date();
    this.#write(socket, {
      id: request.id,
      result: {
        ok: true,
        ownerId: owner.ownerId,
        ownerKind: owner.ownerKind,
        sessionId: owner.sessionId,
      },
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

    const params = request.params as {
      messages?: unknown;
      providerOverride?: unknown;
      sessionId?: string;
    };
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
        parseGatewayProviderOverride(params.providerOverride),
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

  async #claimNextGatewayRun(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#gatewayRuns) {
      this.#write(socket, {
        error: { message: "Gateway run queue is not configured" },
        id: request.id,
      });
      return;
    }

    const params = request.params as { ownerId?: string; sessionId?: string };
    if (!params?.ownerId || !params.sessionId) {
      this.#write(socket, {
        error: { message: "ownerId and sessionId are required" },
        id: request.id,
      });
      return;
    }

    const result = this.#gatewayRuns.claimNextRun({
      ownerId: params.ownerId,
      sessionId: params.sessionId,
    });
    if (!result) {
      this.#write(socket, { id: request.id, result: { run: null } });
      return;
    }

    this.#write(socket, {
      id: request.id,
      result: { run: result.run },
    });
    await this.#publishEvent(result.event);
  }

  async #startGatewayRun(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#gatewayRuns) {
      this.#write(socket, {
        error: { message: "Gateway run queue is not configured" },
        id: request.id,
      });
      return;
    }

    const params = request.params as { gatewayRunId?: string; ownerId?: string };
    if (!params?.ownerId || !params.gatewayRunId) {
      this.#write(socket, {
        error: { message: "ownerId and gatewayRunId are required" },
        id: request.id,
      });
      return;
    }

    try {
      const result = this.#gatewayRuns.startRun({
        gatewayRunId: params.gatewayRunId,
        ownerId: params.ownerId,
      });
      this.#write(socket, {
        id: request.id,
        result: { run: result.run },
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

  async #completeGatewayRun(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#gatewayRuns) {
      this.#write(socket, {
        error: { message: "Gateway run queue is not configured" },
        id: request.id,
      });
      return;
    }

    const params = request.params as {
      gatewayRunId?: string;
      ownerId?: string;
      piSessionFile?: string;
      piSessionId?: string;
      text?: string;
    };
    if (!params?.ownerId || !params.gatewayRunId || typeof params.text !== "string") {
      this.#write(socket, {
        error: { message: "ownerId, gatewayRunId, and text are required" },
        id: request.id,
      });
      return;
    }

    try {
      const result = this.#gatewayRuns.completeRun({
        deliveredByStream: this.#streamDelivery?.hasFinished(params.gatewayRunId) === true,
        gatewayRunId: params.gatewayRunId,
        ownerId: params.ownerId,
        ...(params.piSessionFile !== undefined ? { piSessionFile: params.piSessionFile } : {}),
        ...(params.piSessionId !== undefined ? { piSessionId: params.piSessionId } : {}),
        text: params.text,
      });
      this.#write(socket, {
        id: request.id,
        result: { run: result.run },
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

  async #streamGatewayDelta(socket: Socket, request: RpcRequest): Promise<void> {
    const params = request.params as {
      delta?: unknown;
      gatewayRunId?: unknown;
      ownerId?: unknown;
    };
    if (
      typeof params?.ownerId !== "string" ||
      typeof params.gatewayRunId !== "string" ||
      typeof params.delta !== "string"
    ) {
      this.#write(socket, {
        error: { message: "ownerId, gatewayRunId, and delta are required" },
        id: request.id,
      });
      return;
    }

    if (!this.#gatewayRuns || !this.#streamDelivery) {
      this.#write(socket, { id: request.id, result: { streamed: false } });
      return;
    }

    try {
      const run = this.#gatewayRuns.getRun(params.gatewayRunId);
      await this.#streamDelivery.delta({
        delta: params.delta,
        gatewayRunId: params.gatewayRunId,
        sessionId: run.sessionId,
      });
      this.#write(socket, { id: request.id, result: { streamed: true } });
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #finishGatewayStream(socket: Socket, request: RpcRequest): Promise<void> {
    const params = request.params as {
      finalText?: unknown;
      gatewayRunId?: unknown;
      ownerId?: unknown;
    };
    if (typeof params?.ownerId !== "string" || typeof params.gatewayRunId !== "string") {
      this.#write(socket, {
        error: { message: "ownerId and gatewayRunId are required" },
        id: request.id,
      });
      return;
    }

    if (!this.#streamDelivery) {
      this.#write(socket, { id: request.id, result: { streamed: false } });
      return;
    }

    try {
      await this.#streamDelivery.finish({
        ...(typeof params.finalText === "string" ? { finalText: params.finalText } : {}),
        gatewayRunId: params.gatewayRunId,
      });
      this.#write(socket, { id: request.id, result: { streamed: true } });
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #failGatewayRun(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#gatewayRuns) {
      this.#write(socket, {
        error: { message: "Gateway run queue is not configured" },
        id: request.id,
      });
      return;
    }

    const params = request.params as {
      gatewayRunId?: string;
      message?: string;
      ownerId?: string;
    };
    if (!params?.ownerId || !params.gatewayRunId || !params.message) {
      this.#write(socket, {
        error: { message: "ownerId, gatewayRunId, and message are required" },
        id: request.id,
      });
      return;
    }

    try {
      const result = this.#gatewayRuns.failRun({
        gatewayRunId: params.gatewayRunId,
        message: params.message,
        ownerId: params.ownerId,
      });
      this.#write(socket, {
        id: request.id,
        result: { run: result.run },
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

  #listTools(socket: Socket, request: RpcRequest): void {
    if (!this.#logicalTools) {
      this.#write(socket, {
        error: { message: "Logical tools are not configured" },
        id: request.id,
      });
      return;
    }

    this.#write(socket, {
      id: request.id,
      result: {
        tools: this.#logicalTools.list().map((tool) => ({
          description: tool.description,
          inputSchema: tool.inputSchema,
          name: tool.name,
        })),
      },
    });
  }

  async #runTool(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#logicalTools) {
      this.#write(socket, {
        error: { message: "Logical tools are not configured" },
        id: request.id,
      });
      return;
    }

    const params = request.params as {
      input?: unknown;
      name?: string;
      sessionId?: string;
    };
    if (!params?.sessionId || !params.name) {
      this.#write(socket, {
        error: { message: "sessionId and name are required" },
        id: request.id,
      });
      return;
    }

    try {
      const output = await this.#logicalTools.run(params.name, params.input ?? {}, {
        sessionId: params.sessionId,
      });
      this.#write(socket, {
        id: request.id,
        result: { output },
      });
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
    explicitProviderOverride?: ReturnType<typeof parseGatewayProviderOverride>,
  ): Promise<{ events: EventRecord[]; output: { text: string } }> {
    if (!this.#gatewayRunner) {
      throw new Error("Gateway runner is not configured");
    }

    const afterEventId = this.#store.getLatestEventId(sessionId);
    const providerOverride = explicitProviderOverride ?? this.#providerOverrides?.({ sessionId });
    const output = await this.#gatewayRunner.runTurn({
      messages,
      ...(providerOverride !== undefined ? { providerOverride } : {}),
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

function getQueuedRunPiSessionFile(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  return typeof record.piSessionFile === "string" ? record.piSessionFile : undefined;
}

function isPiMode(value: unknown): value is PiHandshakeRecord["mode"] {
  return value === "json" || value === "print" || value === "rpc" || value === "tui";
}

function piOwnerKindForMode(mode: PiHandshakeRecord["mode"]): PiOwnerKind {
  return mode === "tui" ? "tui_pi" : "headless_pi";
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
