import type { EventRecord } from "@/db/event-store.js";
import type { GatewayMessage } from "./runner.js";

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
      const text = payloadText(event.payload);
      if (text) {
        messages.push({ content: text, role: "user" });
      }
      continue;
    }

    if (event.type === "gateway.message") {
      const text = payloadText(event.payload);
      if (text) {
        messages.push({ content: text, role: "assistant" });
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
