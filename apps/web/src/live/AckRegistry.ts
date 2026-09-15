/**
 * Correlates Live control-command acknowledgments by `client_event_id`
 * (binding spec 1.2.1 §13.3). Waiters time out at the application budget;
 * unmatched or id-less acknowledgments never resolve a different waiter.
 */

import {
  traceAckErrorType,
  traceAckRegistry,
  type StartupTraceContext,
} from "./StartupTrace";

export class AckTimeoutError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Timed out waiting for acknowledgment of event "${eventId}"`);
    this.name = "AckTimeoutError";
    this.eventId = eventId;
  }
}

interface PendingAck {
  resolve: (event: { client_event_id: string }) => void;
  reject: (error: Error) => void;
  timer: number;
  traceContext?: StartupTraceContext;
}

export class AckRegistry {
  private readonly pending = new Map<string, PendingAck>();

  get pendingCount(): number {
    return this.pending.size;
  }

  waitFor(
    eventId: string,
    timeoutMs: number,
    traceContext?: StartupTraceContext,
  ): Promise<{ client_event_id: string }> {
    if (this.pending.has(eventId)) {
      throw new Error(
        `Acknowledgment waiter already exists for event "${eventId}"`,
      );
    }
    return new Promise<{ client_event_id: string }>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(eventId);
        traceAckRegistry("ack.timeout", {
          clientEventId: eventId,
          pendingCount: this.pending.size,
          errorType: "AckTimeoutError",
          ...traceContext,
        });
        reject(new AckTimeoutError(eventId));
      }, timeoutMs);
      this.pending.set(eventId, { resolve, reject, timer, traceContext });
      traceAckRegistry("ack.wait", {
        clientEventId: eventId,
        pendingCount: this.pending.size,
        ...traceContext,
      });
    });
  }

  traceContextFor(clientEventId: string | undefined): StartupTraceContext | undefined {
    if (clientEventId === undefined) return undefined;
    return this.pending.get(clientEventId)?.traceContext;
  }

  accept(event: { client_event_id?: string }): void {
    if (event.client_event_id === undefined) return;
    const waiter = this.pending.get(event.client_event_id);
    if (waiter === undefined) return;
    this.pending.delete(event.client_event_id);
    traceAckRegistry("ack.resolve", {
      clientEventId: event.client_event_id,
      pendingCount: this.pending.size,
      ...waiter.traceContext,
    });
    window.clearTimeout(waiter.timer);
    waiter.resolve({ client_event_id: event.client_event_id });
  }

  fail(event: {
    client_event_id?: string;
    message: string;
    errorType?: string;
  }): void {
    if (event.client_event_id === undefined) return;
    const waiter = this.pending.get(event.client_event_id);
    if (waiter === undefined) return;
    this.pending.delete(event.client_event_id);
    traceAckRegistry("ack.reject", {
      clientEventId: event.client_event_id,
      pendingCount: this.pending.size,
      errorType: event.errorType ?? "server_error",
      ...waiter.traceContext,
    });
    window.clearTimeout(waiter.timer);
    waiter.reject(new Error(event.message));
  }

  rejectAll(error: Error): void {
    const waiters = [...this.pending.entries()];
    this.pending.clear();
    for (const [clientEventId, waiter] of waiters) {
      traceAckRegistry("ack.reject_all", {
        clientEventId,
        pendingCount: this.pending.size,
        errorType: traceAckErrorType(error),
        ...waiter.traceContext,
      });
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
