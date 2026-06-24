import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventRecord } from "@/db/event-store.js";

export type DeliveryReceiptStatus = "failed" | "pending" | "sent" | "skipped" | "updated";

export type DeliveryReceiptRecord = {
  createdAt: Date;
  eventId: number;
  failureReason: string | null;
  id: string;
  platform: string;
  remoteMessageId: string | null;
  status: DeliveryReceiptStatus;
  targetId: string;
  updatedAt: Date;
};

type DeliveryReceiptRow = {
  created_at: number;
  event_id: number;
  failure_reason: string | null;
  id: string;
  platform: string;
  remote_message_id: string | null;
  status: DeliveryReceiptStatus;
  target_id: string;
  updated_at: number;
};

export type PlatformDeliveryAdapter = {
  deliver(input: { event: EventRecord; targetId: string }): Promise<{ remoteMessageId?: string }>;
};

export type DeliveryResult = {
  receipt: DeliveryReceiptRecord;
  remoteMessageId: string | null;
  status: Extract<DeliveryReceiptStatus, "sent" | "skipped">;
};

export class DeliveryReceiptStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  begin(input: { eventId: number; platform: string; targetId: string }): DeliveryReceiptRecord {
    const existing = this.getReceipt(input.eventId, input.platform, input.targetId);
    if (existing) {
      return existing;
    }

    const id = randomUUID();
    const now = Date.now();
    this.#sqlite
      .prepare(
        "insert into delivery_receipts (id, event_id, platform, target_id, status, remote_message_id, failure_reason, created_at, updated_at) values (?, ?, ?, ?, 'pending', null, null, ?, ?)",
      )
      .run(id, input.eventId, input.platform, input.targetId, now, now);

    return this.getReceipt(input.eventId, input.platform, input.targetId) as DeliveryReceiptRecord;
  }

  markSent(input: {
    eventId: number;
    platform: string;
    remoteMessageId?: string;
    targetId: string;
  }): DeliveryReceiptRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update delivery_receipts set status = 'sent', remote_message_id = ?, failure_reason = null, updated_at = ? where event_id = ? and platform = ? and target_id = ?",
      )
      .run(input.remoteMessageId ?? null, now, input.eventId, input.platform, input.targetId);

    return this.getReceipt(input.eventId, input.platform, input.targetId) as DeliveryReceiptRecord;
  }

  markFailed(input: {
    eventId: number;
    failureReason: string;
    platform: string;
    targetId: string;
  }): DeliveryReceiptRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update delivery_receipts set status = 'failed', failure_reason = ?, updated_at = ? where event_id = ? and platform = ? and target_id = ?",
      )
      .run(input.failureReason, now, input.eventId, input.platform, input.targetId);

    return this.getReceipt(input.eventId, input.platform, input.targetId) as DeliveryReceiptRecord;
  }

  getReceipt(
    eventId: number,
    platform: string,
    targetId: string,
  ): DeliveryReceiptRecord | undefined {
    const row = this.#sqlite
      .prepare(
        "select * from delivery_receipts where event_id = ? and platform = ? and target_id = ?",
      )
      .get(eventId, platform, targetId) as DeliveryReceiptRow | undefined;

    return row ? mapReceipt(row) : undefined;
  }
}

export class DeliveryRouter {
  readonly #adapters: Record<string, PlatformDeliveryAdapter>;
  readonly #receipts: DeliveryReceiptStore;

  constructor(options: {
    adapters: Record<string, PlatformDeliveryAdapter>;
    receipts: DeliveryReceiptStore;
  }) {
    this.#adapters = options.adapters;
    this.#receipts = options.receipts;
  }

  async deliver(input: {
    event: EventRecord;
    platform: string;
    targetId: string;
  }): Promise<DeliveryResult> {
    const adapter = this.#adapters[input.platform];
    if (!adapter) {
      throw new Error(`Delivery adapter is not configured: ${input.platform}`);
    }

    const receipt = this.#receipts.begin({
      eventId: input.event.id,
      platform: input.platform,
      targetId: input.targetId,
    });

    if (receipt.status === "sent") {
      return {
        receipt,
        remoteMessageId: receipt.remoteMessageId,
        status: "skipped",
      };
    }

    try {
      const result = await adapter.deliver({
        event: input.event,
        targetId: input.targetId,
      });
      const sentReceipt = this.#receipts.markSent({
        eventId: input.event.id,
        platform: input.platform,
        targetId: input.targetId,
        ...(result.remoteMessageId !== undefined
          ? { remoteMessageId: result.remoteMessageId }
          : {}),
      });

      return {
        receipt: sentReceipt,
        remoteMessageId: sentReceipt.remoteMessageId,
        status: "sent",
      };
    } catch (error) {
      this.#receipts.markFailed({
        eventId: input.event.id,
        failureReason: error instanceof Error ? error.message : String(error),
        platform: input.platform,
        targetId: input.targetId,
      });
      throw error;
    }
  }
}

function mapReceipt(row: DeliveryReceiptRow): DeliveryReceiptRecord {
  return {
    createdAt: new Date(row.created_at),
    eventId: row.event_id,
    failureReason: row.failure_reason,
    id: row.id,
    platform: row.platform,
    remoteMessageId: row.remote_message_id,
    status: row.status,
    targetId: row.target_id,
    updatedAt: new Date(row.updated_at),
  };
}
