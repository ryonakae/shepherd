import type { EventRecord } from "@/db/event-store.js";

export type GatewayMessage = {
  content: string;
  role: "assistant" | "system" | "user";
};

export function buildGatewayMessagesFromEvents(
  events: EventRecord[],
  options: { summary?: string } = {},
): GatewayMessage[] {
  const messages: GatewayMessage[] = [];

  if (options.summary) {
    messages.push({
      content: `Session summary so far:\n${options.summary}`,
      role: "system",
    });
  }

  for (const event of events) {
    if (event.type === "user.message") {
      const text = userContextText(event.payload);
      if (text) {
        messages.push({ content: text, role: "user" });
      }
      continue;
    }

    if (event.type === "assistant.message") {
      const text = assistantContextText(event.payload);
      if (text) {
        messages.push({ content: text, role: "assistant" });
      }
      continue;
    }

    if (event.type === "pi.tool.completed" || event.type === "pi.tool.failed") {
      const text = payloadText(event.payload);
      if (text) {
        messages.push({ content: `Pi tool: ${text}`, role: "system" });
      }
      continue;
    }

    if (event.type === "recovery.note") {
      const message = payloadMessage(event.payload);
      if (message) {
        messages.push({ content: `Recovery note: ${message}`, role: "system" });
      }
    }
  }

  return messages;
}

function userContextText(payload: unknown): string | undefined {
  const text = payloadText(payload);
  if (!text) {
    return undefined;
  }
  const delivery = payloadDelivery(payload);
  const source = payloadSourcePlatform(payload);
  if (delivery === "steer") {
    return `Pi steer: ${text}`;
  }
  if (delivery === "followUp") {
    return `Pi follow-up: ${text}`;
  }
  if (source === "pi") {
    return `Pi: ${text}`;
  }
  if (source === "pi-rpc") {
    return `Pi RPC: ${text}`;
  }
  return text;
}

function assistantContextText(payload: unknown): string | undefined {
  const text = payloadText(payload);
  if (!text) {
    return undefined;
  }
  return payloadSourceRuntime(payload) === "pi" ? `Pi assistant: ${text}` : text;
}

function payloadText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

function payloadMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function payloadDelivery(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const delivery = (payload as { delivery?: unknown }).delivery;
  return typeof delivery === "string" ? delivery : undefined;
}

function payloadSourcePlatform(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const presentation = (payload as { presentation?: unknown }).presentation;
  if (typeof presentation !== "object" || presentation === null) {
    return undefined;
  }
  const source = (presentation as { sourcePlatform?: unknown }).sourcePlatform;
  return typeof source === "string" ? source : undefined;
}

function payloadSourceRuntime(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const sourceRuntime = (payload as { sourceRuntime?: unknown }).sourceRuntime;
  return typeof sourceRuntime === "string" ? sourceRuntime : undefined;
}
