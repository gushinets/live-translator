/**
 * Correlates Live control-command acknowledgments by `client_event_id`
 * (binding spec 1.2.1 §13.3). Waiters time out at the application budget;
 * unmatched or id-less acknowledgments never resolve a different waiter.
 */

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
}

export class AckRegistry {
  private readonly pending = new Map<string, PendingAck>();

  get pendingCount(): number {
    return this.pending.size;
  }

  waitFor(
    eventId: string,
    timeoutMs: number,
  ): Promise<{ client_event_id: string }> {
    if (this.pending.has(eventId)) {
      throw new Error(
        `Acknowledgment waiter already exists for event "${eventId}"`,
      );
    }
    return new Promise<{ client_event_id: string }>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(eventId);
        reject(new AckTimeoutError(eventId));
      }, timeoutMs);
      this.pending.set(eventId, { resolve, reject, timer });
    });
  }

  accept(event: { client_event_id?: string }): void {
    if (event.client_event_id === undefined) return;
    const waiter = this.pending.get(event.client_event_id);
    if (waiter === undefined) return;
    this.pending.delete(event.client_event_id);
    window.clearTimeout(waiter.timer);
    waiter.resolve({ client_event_id: event.client_event_id });
  }

  fail(event: { client_event_id?: string; message: string }): void {
    if (event.client_event_id === undefined) return;
    const waiter = this.pending.get(event.client_event_id);
    if (waiter === undefined) return;
    this.pending.delete(event.client_event_id);
    window.clearTimeout(waiter.timer);
    waiter.reject(new Error(event.message));
  }

  rejectAll(error: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
