import { createHash } from "node:crypto";
import type { PiOwnerKind, PiTurnSource } from "@/db/pi-turns.js";

export type PiInputDelivery = "followUp" | "immediate" | "steer";
export type PiToolStatus = "completed" | "failed" | "started";
export type PiTerminalStatus = "completed" | "failed";

export type PiMirrorUserMessageParams = {
  avatarUrl?: string;
  delivery: PiInputDelivery;
  deliverySequence?: number;
  displayName: string;
  ownerId: string;
  ownerKind: PiOwnerKind;
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  sessionId: string;
  source: "interactive" | "rpc";
  text: string;
};

export type PiStartTurnParams = {
  inputEventIds: number[];
  ownerId: string;
  ownerKind: PiOwnerKind;
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  sessionId: string;
  source: PiTurnSource;
  triggeringEventId?: number;
};

export type PiStreamDeltaParams = {
  delta: string;
  ownerId: string;
  piTurnId: string;
  sessionId: string;
};

export type PiStreamFinishParams = {
  finalText?: string;
  ownerId: string;
  piTurnId: string;
  sessionId: string;
};

export type PiStreamSegmentBreakParams = {
  ownerId: string;
  piTurnId: string;
  sessionId: string;
};

export type PiRecordToolProgressParams = {
  durationMs?: number;
  isError?: boolean;
  ownerId: string;
  ownerKind: PiOwnerKind;
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  preview?: string;
  sessionId: string;
  status: PiToolStatus;
  text: string;
  toolCallId: string;
  toolName: string;
  triggeringEventId?: number;
};

export type PiCompleteTurnParams = {
  finalText: string;
  ownerId: string;
  ownerKind: PiOwnerKind;
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  sessionId: string;
  triggeringEventId?: number;
};

export type PiFailTurnParams = {
  message: string;
  ownerId: string;
  ownerKind: PiOwnerKind;
  piSessionFile: string;
  piSessionId: string;
  piTurnId: string;
  sessionId: string;
  triggeringEventId?: number;
};

export function piTurnIdempotencyKey(
  piTurnId: string,
  suffix: "assistant" | "completed" | "failed" | "started",
): string {
  return `pi:turn:${piTurnId}:${suffix}`;
}

export function piToolIdempotencyKey(
  piTurnId: string,
  toolCallId: string,
  status: PiToolStatus,
): string {
  return `pi:turn:${piTurnId}:tool:${toolCallId}:${status}`;
}

export function piUserMessageIdempotencyKey(input: {
  delivery: PiInputDelivery;
  deliverySequence?: number;
  piTurnId: string;
  text: string;
}): string {
  return `pi:turn:${input.piTurnId}:user:${input.delivery}:${input.deliverySequence ?? 0}:${createHash("sha256").update(input.text).digest("hex").slice(0, 16)}`;
}

export function sanitizePiPreviewText(value: unknown, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? 240;
  const redacted = String(value ?? "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/\n{4,}/g, "\n\n");

  return redacted.length > maxLength ? `${redacted.slice(0, Math.max(0, maxLength - 3))}...` : redacted;
}

export function parsePiMirrorUserMessageParams(value: unknown): PiMirrorUserMessageParams {
  const record = requireRecord(value);
  return {
    delivery: requireEnum(record.delivery, ["followUp", "immediate", "steer"], "delivery"),
    displayName: requireString(record.displayName, "displayName"),
    ownerId: requireString(record.ownerId, "ownerId"),
    ownerKind: requireOwnerKind(record.ownerKind),
    piSessionFile: requireString(record.piSessionFile, "piSessionFile"),
    piSessionId: requireString(record.piSessionId, "piSessionId"),
    piTurnId: requireString(record.piTurnId, "piTurnId"),
    sessionId: requireString(record.sessionId, "sessionId"),
    source: requireEnum(record.source, ["interactive", "rpc"], "source"),
    text: requireString(record.text, "text"),
    ...(typeof record.avatarUrl === "string" ? { avatarUrl: record.avatarUrl } : {}),
    ...(typeof record.deliverySequence === "number"
      ? { deliverySequence: record.deliverySequence }
      : {}),
  };
}

export function parsePiStartTurnParams(value: unknown): PiStartTurnParams {
  const record = requireRecord(value);
  return {
    inputEventIds: Array.isArray(record.inputEventIds)
      ? record.inputEventIds.filter((item): item is number => typeof item === "number")
      : [],
    ownerId: requireString(record.ownerId, "ownerId"),
    ownerKind: requireOwnerKind(record.ownerKind),
    piSessionFile: requireString(record.piSessionFile, "piSessionFile"),
    piSessionId: requireString(record.piSessionId, "piSessionId"),
    piTurnId: requireString(record.piTurnId, "piTurnId"),
    sessionId: requireString(record.sessionId, "sessionId"),
    source: requireEnum(record.source, ["extension", "interactive", "rpc"], "source"),
    ...(typeof record.triggeringEventId === "number"
      ? { triggeringEventId: record.triggeringEventId }
      : {}),
  };
}

export function parsePiRecordToolProgressParams(value: unknown): PiRecordToolProgressParams {
  const record = requireRecord(value);
  return {
    ownerId: requireString(record.ownerId, "ownerId"),
    ownerKind: requireOwnerKind(record.ownerKind),
    piSessionFile: requireString(record.piSessionFile, "piSessionFile"),
    piSessionId: requireString(record.piSessionId, "piSessionId"),
    piTurnId: requireString(record.piTurnId, "piTurnId"),
    sessionId: requireString(record.sessionId, "sessionId"),
    status: requireEnum(record.status, ["completed", "failed", "started"], "status"),
    text: requireString(record.text, "text"),
    toolCallId: requireString(record.toolCallId, "toolCallId"),
    toolName: requireString(record.toolName, "toolName"),
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
    ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
    ...(typeof record.preview === "string" ? { preview: record.preview } : {}),
    ...(typeof record.triggeringEventId === "number"
      ? { triggeringEventId: record.triggeringEventId }
      : {}),
  };
}

export function parsePiCompleteTurnParams(value: unknown): PiCompleteTurnParams {
  const record = requireRecord(value);
  return {
    finalText: requireString(record.finalText, "finalText"),
    ownerId: requireString(record.ownerId, "ownerId"),
    ownerKind: requireOwnerKind(record.ownerKind),
    piSessionFile: requireString(record.piSessionFile, "piSessionFile"),
    piSessionId: requireString(record.piSessionId, "piSessionId"),
    piTurnId: requireString(record.piTurnId, "piTurnId"),
    sessionId: requireString(record.sessionId, "sessionId"),
    ...(typeof record.triggeringEventId === "number"
      ? { triggeringEventId: record.triggeringEventId }
      : {}),
  };
}

export function parsePiFailTurnParams(value: unknown): PiFailTurnParams {
  const record = requireRecord(value);
  return {
    message: requireString(record.message, "message"),
    ownerId: requireString(record.ownerId, "ownerId"),
    ownerKind: requireOwnerKind(record.ownerKind),
    piSessionFile: requireString(record.piSessionFile, "piSessionFile"),
    piSessionId: requireString(record.piSessionId, "piSessionId"),
    piTurnId: requireString(record.piTurnId, "piTurnId"),
    sessionId: requireString(record.sessionId, "sessionId"),
    ...(typeof record.triggeringEventId === "number"
      ? { triggeringEventId: record.triggeringEventId }
      : {}),
  };
}

export function parsePiStreamDeltaParams(value: unknown): PiStreamDeltaParams {
  const record = requireRecord(value);
  return {
    delta: requireString(record.delta, "delta"),
    ownerId: requireString(record.ownerId, "ownerId"),
    piTurnId: requireString(record.piTurnId, "piTurnId"),
    sessionId: requireString(record.sessionId, "sessionId"),
  };
}

export function parsePiStreamFinishParams(value: unknown): PiStreamFinishParams {
  const record = requireRecord(value);
  return {
    ownerId: requireString(record.ownerId, "ownerId"),
    piTurnId: requireString(record.piTurnId, "piTurnId"),
    sessionId: requireString(record.sessionId, "sessionId"),
    ...(typeof record.finalText === "string" ? { finalText: record.finalText } : {}),
  };
}

export function parsePiStreamSegmentBreakParams(value: unknown): PiStreamSegmentBreakParams {
  const record = requireRecord(value);
  return {
    ownerId: requireString(record.ownerId, "ownerId"),
    piTurnId: requireString(record.piTurnId, "piTurnId"),
    sessionId: requireString(record.sessionId, "sessionId"),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("params must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireOwnerKind(value: unknown): PiOwnerKind {
  return requireEnum(value, ["headless_pi", "tui_pi"], "ownerKind");
}

function requireEnum<const T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}
