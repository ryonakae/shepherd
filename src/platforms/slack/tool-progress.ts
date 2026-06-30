import type { SlackPostMessageClient } from "./delivery.js";
import { parseSlackTargetId } from "./delivery.js";

export type SlackToolProgressMode = "compact" | "off" | "verbose";

export type SlackToolProgressRecordInput = {
  durationMs?: number;
  piTurnId: string;
  preview?: string;
  status: "completed" | "failed" | "started";
  targetId: string;
  text: string;
  toolName: string;
};

type ToolProgressEntry = {
  durationMs?: number;
  preview?: string;
  status: "completed" | "failed" | "started";
  text: string;
  toolName: string;
};

type ToolProgressState = {
  entries: Map<string, ToolProgressEntry>;
  remoteMessageId?: string;
  targetId: string;
};

export class SlackToolProgressDelivery {
  readonly #client: SlackPostMessageClient;
  readonly #mode: Exclude<SlackToolProgressMode, "off">;
  readonly #states = new Map<string, ToolProgressState>();

  constructor(options: {
    client: SlackPostMessageClient;
    mode: Exclude<SlackToolProgressMode, "off">;
  }) {
    this.#client = options.client;
    this.#mode = options.mode;
  }

  async recordToolProgress(input: SlackToolProgressRecordInput): Promise<void> {
    const state = this.#ensureState(input.piTurnId, input.targetId);
    state.entries.set(input.toolName, {
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.preview !== undefined ? { preview: sanitizeProgressText(input.preview) } : {}),
      status: input.status,
      text: sanitizeProgressText(input.text),
      toolName: input.toolName,
    });
    await this.#renderState(state);
  }

  async completeToolProgress(input: { piTurnId: string; targetId: string }): Promise<void> {
    await this.#finish(input.piTurnId, input.targetId, "Tool progress complete");
  }

  async failToolProgress(input: {
    message: string;
    piTurnId: string;
    targetId: string;
  }): Promise<void> {
    await this.#finish(
      input.piTurnId,
      input.targetId,
      `Tool progress stopped: ${sanitizeProgressText(input.message, { maxLength: 160 })}`,
    );
  }

  #ensureState(piTurnId: string, targetId: string): ToolProgressState {
    const key = stateKey(piTurnId, targetId);
    const existing = this.#states.get(key);
    if (existing) {
      return existing;
    }
    const state: ToolProgressState = { entries: new Map(), targetId };
    this.#states.set(key, state);
    return state;
  }

  async #renderState(state: ToolProgressState): Promise<void> {
    const text = renderProgress([...state.entries.values()], this.#mode);
    const target = parseSlackTargetId(state.targetId);
    if (!state.remoteMessageId) {
      const response = await this.#client.chat.postMessage({
        channel: target.channelId,
        text,
        ...(target.threadTs !== undefined ? { thread_ts: target.threadTs } : {}),
      });
      if (typeof response.ts === "string") {
        state.remoteMessageId = response.ts;
      }
      return;
    }

    if (!this.#client.chat.update) {
      return;
    }
    await this.#client.chat.update({
      channel: target.channelId,
      text,
      ts: state.remoteMessageId,
    });
  }

  async #finish(piTurnId: string, targetId: string, fallbackText: string): Promise<void> {
    const key = stateKey(piTurnId, targetId);
    const state = this.#states.get(key);
    if (!state) {
      return;
    }
    this.#states.delete(key);
    if (!state.remoteMessageId || !this.#client.chat.update) {
      return;
    }
    const target = parseSlackTargetId(targetId);
    await this.#client.chat.update({
      channel: target.channelId,
      text: renderProgress([...state.entries.values()], this.#mode, fallbackText),
      ts: state.remoteMessageId,
    });
  }
}

function renderProgress(
  entries: ToolProgressEntry[],
  mode: Exclude<SlackToolProgressMode, "off">,
  fallbackText = "Tool progress",
): string {
  if (entries.length === 0) {
    return fallbackText;
  }

  const lines = entries.map((entry) => renderEntry(entry, mode));
  return ["Tool progress", ...lines].join("\n");
}

function renderEntry(
  entry: ToolProgressEntry,
  mode: Exclude<SlackToolProgressMode, "off">,
): string {
  const marker = statusMarker(entry.status);
  const duration = entry.durationMs === undefined ? "" : ` (${entry.durationMs}ms)`;
  if (mode === "compact") {
    return `${marker} ${entry.toolName}: ${entry.text}${duration}`;
  }

  const preview = entry.preview ? `\n  ${entry.preview}` : "";
  return `${marker} ${entry.toolName}: ${entry.text}${duration}${preview}`;
}

function statusMarker(status: "completed" | "failed" | "started"): string {
  if (status === "completed") {
    return "✓";
  }
  if (status === "failed") {
    return "✕";
  }
  return "…";
}

function stateKey(piTurnId: string, targetId: string): string {
  return `${piTurnId}\0${targetId}`;
}

function sanitizeProgressText(value: string, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? 240;
  const redacted = value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/\n{4,}/g, "\n\n");

  return redacted.length > maxLength
    ? `${redacted.slice(0, Math.max(0, maxLength - 3))}...`
    : redacted;
}
