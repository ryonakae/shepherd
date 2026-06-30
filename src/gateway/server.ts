import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type ConfigLoadResult, loadShepherdConfig } from "@/config/load.js";
import type { EventRecord, EventStore, SessionMetadata } from "@/db/event-store.js";
import type { PiTurnQueue } from "@/gateway/pi-turn-queue.js";
import {
  parsePiCompleteTurnParams,
  parsePiFailTurnParams,
  parsePiMirrorUserMessageParams,
  parsePiRecordToolProgressParams,
  parsePiStartTurnParams,
  parsePiStreamDeltaParams,
  parsePiStreamFinishParams,
  parsePiStreamSegmentBreakParams,
  piToolIdempotencyKey,
  piTurnIdempotencyKey,
  piUserMessageIdempotencyKey,
  sanitizePiPreviewText,
} from "@/gateway/pi-runtime-events.js";
import type { LogicalToolRunner } from "@/gateway/tools.js";
import { toHerdrProgressSignal } from "@/herdr/progress.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";

type ShepherdGatewayServerOptions = {
  configPath?: string;
  gatewayId?: string;
  deliveryFanout?: EventDeliveryFanout;
  piTurns?: PiTurnQueue;
  headlessPi?: HeadlessPiSupervisorService;
  localWorkingContexts?: LocalWorkingContextResolver;
  logicalTools?: LogicalToolService;
  ownerHeartbeatTimeoutMs?: number;
  piSessions?: PiSessionMetadataService;
  runtimeDelivery?: PiRuntimeDeliveryService;
  streamDelivery?: PiRuntimeDeliveryService;
  socketPath: string;
  store: EventStore;
};

type EventDeliveryFanout = {
  deliverEvent(event: EventRecord): Promise<unknown>;
};

type HeadlessPiSupervisorService = {
  ensureStarted(input: { piSessionFile: string; sessionId: string }): unknown;
};

type LocalWorkingContextResolver = {
  resolve(input: { label?: string; path?: string; slug?: string }): { id: string };
};

type LogicalToolService = Pick<LogicalToolRunner, "list" | "run">;

type PiSessionMetadataService = {
  ensureForSession(sessionId: string): NonNullable<SessionMetadata["pi"]>;
};

type PiRuntimeDeliveryService = {
  completeToolProgress?(input: { piTurnId: string; sessionId: string }): Promise<void>;
  delta(input: { delta: string; sessionId: string; streamId: string }): Promise<void>;
  failToolProgress?(input: { message: string; piTurnId: string; sessionId: string }): Promise<void>;
  finish(input: { finalText?: string; streamId: string }): Promise<void>;
  hasFinished(streamId: string): boolean;
  recordToolProgress?(input: {
    durationMs?: number;
    piTurnId: string;
    preview?: string;
    sessionId: string;
    status: "completed" | "failed" | "started";
    text: string;
    toolName: string;
  }): Promise<void>;
  segmentBreak?(input: { sessionId: string; streamId: string }): Promise<void>;
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
  gatewayId: string;
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

export class ShepherdGatewayServer {
  readonly #configPath: string | undefined;
  readonly #gatewayId: string;
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #deliveryFanout: EventDeliveryFanout | undefined;
  readonly #piTurns: PiTurnQueue | undefined;
  readonly #headlessPi: HeadlessPiSupervisorService | undefined;
  readonly #localWorkingContexts: LocalWorkingContextResolver | undefined;
  readonly #logicalTools: LogicalToolService | undefined;
  readonly #piHandshakeWaiters: Array<(handshake: PiHandshakeRecord) => void> = [];
  readonly #piOwners = new Map<string, PiOwnerRecord>();
  readonly #piSessions: PiSessionMetadataService | undefined;
  readonly #runtimeDelivery: PiRuntimeDeliveryService | undefined;
  readonly #store: EventStore;
  readonly #subscriptions = new Map<string, Set<Socket>>();
  #config: ConfigLoadResult | undefined;
  #lastPiHandshake: PiHandshakeRecord | undefined;
  #ownerHeartbeatTimeoutMs = 45_000;

  constructor(options: ShepherdGatewayServerOptions) {
    this.#configPath = options.configPath;
    this.#gatewayId = options.gatewayId ?? "default";
    this.#deliveryFanout = options.deliveryFanout;
    this.#piTurns = options.piTurns;
    this.#headlessPi = options.headlessPi;
    this.#localWorkingContexts = options.localWorkingContexts;
    this.#logicalTools = options.logicalTools;
    this.#ownerHeartbeatTimeoutMs =
      options.ownerHeartbeatTimeoutMs ?? this.#ownerHeartbeatTimeoutMs;
    this.#piSessions = options.piSessions;
    this.#runtimeDelivery = options.runtimeDelivery ?? options.streamDelivery;
    this.#socketPath = options.socketPath;
    this.#store = options.store;
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
    this.#subscriptions.clear();

    await new Promise<void>((resolve, reject) => {
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

    if (existsSync(this.#socketPath)) {
      unlinkSync(this.#socketPath);
    }
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

  reapStalePiOwners(now = Date.now()): void {
    this.#pruneStaleOwners(now);
  }

  async receiveUserMessage(input: ReceiveUserMessageInput): Promise<{
    event: EventRecord;
    gatewayEvents: EventRecord[];
  }> {
    const event = this.#storeUserMessage(input);
    await this.#publishEvent(event);
    const gatewayEvents = await this.#queuePiTurnForUserMessage(input, event);

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

  async #queuePiTurnForUserMessage(
    input: ReceiveUserMessageInput,
    event: EventRecord,
  ): Promise<EventRecord[]> {
    if (!this.#piTurns) {
      return [];
    }

    const result = this.#piTurns.queueTurn({
      sessionId: input.sessionId,
      triggeringEventId: event.id,
    });
    await this.#publishEvent(result.event);
    this.#startHeadlessPiForQueuedTurn(input.sessionId, result.event);
    return [result.event];
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

    if (request.method === "pi.ensure_session") {
      this.#ensurePiSession(socket, request);
      return;
    }

    if (request.method === "pi.heartbeat") {
      this.#recordPiHeartbeat(socket, request);
      return;
    }

    if (request.method === "pi.claim_next_turn") {
      void this.#claimNextPiTurn(socket, request);
      return;
    }

    if (request.method === "pi.start_turn") {
      void this.#startPiTurn(socket, request);
      return;
    }

    if (request.method === "pi.mirror_user_message") {
      void this.#mirrorPiUserMessage(socket, request);
      return;
    }

    if (request.method === "pi.stream_delta") {
      void this.#streamPiDelta(socket, request);
      return;
    }

    if (request.method === "pi.stream_finish") {
      void this.#finishPiStream(socket, request);
      return;
    }

    if (request.method === "pi.stream_segment_break") {
      void this.#segmentPiStream(socket, request);
      return;
    }

    if (request.method === "pi.record_tool_progress") {
      void this.#recordPiToolProgress(socket, request);
      return;
    }

    if (request.method === "pi.complete_turn") {
      void this.#completePiTurn(socket, request);
      return;
    }

    if (request.method === "pi.fail_turn") {
      void this.#failPiTurn(socket, request);
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
      workingContextPath?: unknown;
    };
    const channelId = params?.slackAutoBind?.channelId;

    if (params?.slackAutoBind !== undefined && typeof channelId !== "string") {
      this.#write(socket, {
        error: { message: "slackAutoBind.channelId must be a string" },
        id: request.id,
      });
      return;
    }

    if (params?.workingContextPath !== undefined && typeof params.workingContextPath !== "string") {
      this.#write(socket, {
        error: { message: "workingContextPath must be a string" },
        id: request.id,
      });
      return;
    }

    let workingContextId =
      typeof params?.workingContextId === "string" ? params.workingContextId : undefined;
    if (typeof params?.workingContextPath === "string") {
      if (params.workingContextPath.length === 0) {
        this.#write(socket, {
          error: { message: "workingContextPath must be a string" },
          id: request.id,
        });
        return;
      }
      if (workingContextId !== undefined) {
        this.#write(socket, {
          error: { message: "workingContextId and workingContextPath are mutually exclusive" },
          id: request.id,
        });
        return;
      }
      if (!this.#localWorkingContexts) {
        this.#write(socket, {
          error: { message: "Local working context resolver is not configured" },
          id: request.id,
        });
        return;
      }

      try {
        workingContextId = this.#localWorkingContexts.resolve({
          path: params.workingContextPath,
        }).id;
      } catch (error) {
        this.#write(socket, {
          error: { message: error instanceof Error ? error.message : String(error) },
          id: request.id,
        });
        return;
      }
    }

    const session = this.#store.createSession({
      ...(typeof params?.title === "string" ? { title: params.title } : {}),
      ...(workingContextId !== undefined ? { workingContextId } : {}),
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
    await this.#queuePiTurnForUserMessage(input, event);
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

  #startHeadlessPiForQueuedTurn(sessionId: string, event: EventRecord): void {
    if (!this.#headlessPi) {
      return;
    }

    const piSessionFile = getQueuedTurnPiSessionFile(event.payload);
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
      binding?: { gatewayId?: unknown; sessionId?: unknown };
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

    const bindingGatewayId =
      typeof params.binding?.gatewayId === "string" ? params.binding.gatewayId : undefined;
    const bindingMatchesGateway =
      bindingGatewayId === undefined || bindingGatewayId === this.#gatewayId;
    const sessionId =
      bindingMatchesGateway && typeof params.binding?.sessionId === "string"
        ? params.binding.sessionId
        : undefined;
    const ownerKind = piOwnerKindForMode(params.mode);
    const handshake: PiHandshakeRecord = {
      attached: sessionId !== undefined,
      gatewayId: this.#gatewayId,
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
        gatewayId: handshake.gatewayId,
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
        gatewayId: this.#gatewayId,
        ownerId,
        ownerKind,
        session: toWireSession(updated),
        socketPath: this.#socketPath,
      },
    });
  }

  #ensurePiSession(socket: Socket, request: RpcRequest): void {
    const params = request.params as { sessionId?: unknown };
    if (typeof params?.sessionId !== "string") {
      this.#write(socket, { error: { message: "sessionId is required" }, id: request.id });
      return;
    }
    if (!this.#piSessions) {
      this.#write(socket, {
        error: { message: "Pi session metadata store is not configured" },
        id: request.id,
      });
      return;
    }

    try {
      const pi = this.#piSessions.ensureForSession(params.sessionId);
      this.#write(socket, { id: request.id, result: { pi } });
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
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

  async #claimNextPiTurn(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#piTurns) {
      this.#write(socket, {
        error: { message: "Pi turn queue is not configured" },
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

    if (!this.#canOwnerClaim(params.ownerId, params.sessionId)) {
      this.#write(socket, { id: request.id, result: { turn: null } });
      return;
    }

    const result = this.#piTurns.claimNextTurn({
      ownerId: params.ownerId,
      sessionId: params.sessionId,
    });
    this.#write(socket, {
      id: request.id,
      result: { turn: result?.turn ?? null },
    });
  }

  async #startPiTurn(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#piTurns) {
      this.#write(socket, {
        error: { message: "Pi turn queue is not configured" },
        id: request.id,
      });
      return;
    }

    try {
      const params = parsePiStartTurnParams(request.params);
      this.#requirePiOwner(params.ownerId, params.sessionId);
      const result = this.#piTurns.startTurn(params);
      this.#write(socket, { id: request.id, result: { turn: result.turn } });
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

  async #mirrorPiUserMessage(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      const params = parsePiMirrorUserMessageParams(request.params);
      this.#requirePiOwner(params.ownerId, params.sessionId);
      const actorId = `pi:${params.ownerId}`;
      this.#store.upsertActor({
        displayName: params.displayName,
        id: actorId,
        kind: "user",
        presentation: {
          displayName: params.displayName,
          sourcePlatform: params.source === "rpc" ? "pi-rpc" : "pi",
        },
        ...(params.avatarUrl !== undefined ? { avatarUrl: params.avatarUrl } : {}),
        sourcePlatform: params.source === "rpc" ? "pi-rpc" : "pi",
        sourceUserId: params.ownerId,
      });
      const event = this.#store.appendEvent({
        actorId,
        idempotencyKey: piUserMessageIdempotencyKey(params),
        payload: {
          delivery: params.delivery,
          piSessionFile: params.piSessionFile,
          piSessionId: params.piSessionId,
          piTurnId: params.piTurnId,
          presentation: {
            displayName: params.displayName,
            sourcePlatform: params.source === "rpc" ? "pi-rpc" : "pi",
            ...(params.avatarUrl !== undefined ? { avatarUrl: params.avatarUrl } : {}),
          },
          text: params.text,
        },
        sessionId: params.sessionId,
        type: "user.message",
      });
      this.#write(socket, { id: request.id, result: { event: toWireEvent(event) } });
      await this.#publishEvent(event);
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #streamPiDelta(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      const params = parsePiStreamDeltaParams(request.params);
      this.#requirePiOwner(params.ownerId, params.sessionId);
      if (!this.#runtimeDelivery) {
        this.#write(socket, {
          id: request.id,
          result: { reason: "runtime_delivery_unavailable", streamed: false },
        });
        return;
      }
      await this.#runtimeDelivery.delta({
        delta: params.delta,
        sessionId: params.sessionId,
        streamId: params.piTurnId,
      });
      this.#write(socket, { id: request.id, result: { streamed: true } });
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #finishPiStream(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      const params = parsePiStreamFinishParams(request.params);
      this.#requirePiOwner(params.ownerId, params.sessionId);
      if (!this.#runtimeDelivery) {
        this.#write(socket, {
          id: request.id,
          result: { reason: "runtime_delivery_unavailable", streamed: false },
        });
        return;
      }
      await this.#runtimeDelivery.finish({
        ...(params.finalText !== undefined ? { finalText: params.finalText } : {}),
        streamId: params.piTurnId,
      });
      this.#write(socket, { id: request.id, result: { streamed: true } });
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #segmentPiStream(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      const params = parsePiStreamSegmentBreakParams(request.params);
      this.#requirePiOwner(params.ownerId, params.sessionId);
      if (!this.#runtimeDelivery) {
        this.#write(socket, {
          id: request.id,
          result: { reason: "runtime_delivery_unavailable", streamed: false },
        });
        return;
      }
      if (!this.#runtimeDelivery.segmentBreak) {
        this.#write(socket, {
          id: request.id,
          result: { reason: "segment_break_not_supported", streamed: false },
        });
        return;
      }
      await this.#runtimeDelivery.segmentBreak({
        sessionId: params.sessionId,
        streamId: params.piTurnId,
      });
      this.#write(socket, { id: request.id, result: { streamed: true } });
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #recordPiToolProgress(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      const params = parsePiRecordToolProgressParams(request.params);
      this.#requirePiOwner(params.ownerId, params.sessionId);
      const event = this.#store.appendEvent({
        idempotencyKey: piToolIdempotencyKey(params.piTurnId, params.toolCallId, params.status),
        payload: {
          durationMs: params.durationMs,
          isError: params.isError,
          ownerId: params.ownerId,
          ownerKind: params.ownerKind,
          piSessionFile: params.piSessionFile,
          piSessionId: params.piSessionId,
          piTurnId: params.piTurnId,
          preview: sanitizePiPreviewText(params.preview ?? ""),
          text: sanitizePiPreviewText(params.text),
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          ...(params.triggeringEventId !== undefined
            ? { triggeringEventId: params.triggeringEventId }
            : {}),
        },
        sessionId: params.sessionId,
        type: `pi.tool.${params.status}`,
      });
      await this.#runtimeDelivery?.recordToolProgress?.({
        ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
        piTurnId: params.piTurnId,
        ...(params.preview !== undefined ? { preview: sanitizePiPreviewText(params.preview) } : {}),
        sessionId: params.sessionId,
        status: params.status,
        text: sanitizePiPreviewText(params.text),
        toolName: params.toolName,
      });
      this.#write(socket, { id: request.id, result: { event: toWireEvent(event) } });
      await this.#publishEvent(event);
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #completePiTurn(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#piTurns) {
      this.#write(socket, {
        error: { message: "Pi turn queue is not configured" },
        id: request.id,
      });
      return;
    }

    try {
      const params = parsePiCompleteTurnParams(request.params);
      this.#requirePiOwner(params.ownerId, params.sessionId);
      const deliveredByStream = this.#runtimeDelivery?.hasFinished(params.piTurnId) === true;
      const assistant = this.#store.appendEvent({
        idempotencyKey: piTurnIdempotencyKey(params.piTurnId, "assistant"),
        payload: {
          ...(deliveredByStream ? { deliveredByStream: true } : {}),
          ownerId: params.ownerId,
          ownerKind: params.ownerKind,
          piSessionFile: params.piSessionFile,
          piSessionId: params.piSessionId,
          piTurnId: params.piTurnId,
          sourceRuntime: "pi",
          text: params.finalText,
          ...(params.triggeringEventId !== undefined
            ? { triggeringEventId: params.triggeringEventId }
            : {}),
        },
        sessionId: params.sessionId,
        type: "assistant.message",
      });
      const result = this.#piTurns.completeTurnFromPi({
        ownerId: params.ownerId,
        piTurnId: params.piTurnId,
      });
      await this.#runtimeDelivery?.completeToolProgress?.({
        piTurnId: params.piTurnId,
        sessionId: params.sessionId,
      });
      this.#write(socket, {
        id: request.id,
        result: { events: [assistant, ...result.events].map(toWireEvent), turn: result.turn },
      });
      await this.#publishEvent(assistant);
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

  async #failPiTurn(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#piTurns) {
      this.#write(socket, {
        error: { message: "Pi turn queue is not configured" },
        id: request.id,
      });
      return;
    }

    try {
      const params = parsePiFailTurnParams(request.params);
      this.#requirePiOwner(params.ownerId, params.sessionId);
      const result = this.#piTurns.failTurnFromPi({
        message: params.message,
        ownerId: params.ownerId,
        piTurnId: params.piTurnId,
      });
      await this.#runtimeDelivery?.failToolProgress?.({
        message: params.message,
        piTurnId: params.piTurnId,
        sessionId: params.sessionId,
      });
      this.#write(socket, {
        id: request.id,
        result: { events: result.events.map(toWireEvent), turn: result.turn },
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

  #requirePiOwner(ownerId: string, sessionId: string): PiOwnerRecord {
    this.#pruneStaleOwners();
    const owner = this.#piOwners.get(ownerId);
    if (!owner || owner.sessionId !== sessionId) {
      throw new Error("Pi owner is not attached to this session");
    }
    return owner;
  }

  #canOwnerClaim(ownerId: string, sessionId: string): boolean {
    this.#pruneStaleOwners();
    const requester = this.#piOwners.get(ownerId);
    if (requester?.ownerKind === "tui_pi") {
      return requester.sessionId === sessionId;
    }

    for (const owner of this.#piOwners.values()) {
      if (owner.sessionId === sessionId && owner.ownerKind === "tui_pi") {
        return false;
      }
    }

    return true;
  }

  #pruneStaleOwners(now = Date.now()): void {
    for (const [ownerId, owner] of this.#piOwners) {
      if (now - owner.lastHeartbeatAt.getTime() >= this.#ownerHeartbeatTimeoutMs) {
        this.#piOwners.delete(ownerId);
        const recovery = this.#piTurns?.markRunningTurnRecoveryRequired({
          message: "Pi owner heartbeat timed out while a Pi turn was active.",
          ownerId,
          sessionId: owner.sessionId,
        });
        if (recovery) {
          for (const event of recovery.events) {
            void this.#publishEvent(event);
          }
        }
      }
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
          ...(tool.label !== undefined ? { label: tool.label } : {}),
          name: tool.name,
          ...(tool.promptGuidelines !== undefined
            ? { promptGuidelines: tool.promptGuidelines }
            : {}),
          ...(tool.promptSnippet !== undefined ? { promptSnippet: tool.promptSnippet } : {}),
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
      piTurnId?: string;
      sessionId?: string;
    };
    if (!params?.sessionId || !params.name || !params.piTurnId) {
      this.#write(socket, {
        error: { message: "sessionId, piTurnId, and name are required" },
        id: request.id,
      });
      return;
    }

    try {
      const output = await this.#logicalTools.run(params.name, params.input ?? {}, {
        piTurnId: params.piTurnId,
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

function getQueuedTurnPiSessionFile(payload: unknown): string | undefined {
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
