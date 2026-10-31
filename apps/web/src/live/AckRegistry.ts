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
import { observe, type DiagnosticSink } from "../diagnostics/observe";
import type { DiagnosticCommand } from "../../../../types/diagnostics.js";

export class AckTimeoutError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Timed out waiting for acknowledgment of event "${eventId}"`);
    this.name = "AckTimeoutError";
    this.eventId = eventId;
  }
}

interface PendingAck {
  commandType?: DiagnosticCommand;
  promptId?: string;
  resolve: (event: { client_event_id: string }) => void;
  reject: (error: Error) => void;
  timer: number;
  traceContext?: StartupTraceContext;
}

export class AckRegistry {
  diagnostics: DiagnosticSink | undefined;
  setCommandType(id: string, type: DiagnosticCommand): void { const pending = this.pending.get(id); if (pending) pending.commandType = type; }
  private readonly pending = new Map<string, PendingAck>();

  get pendingCount(): number {
    return this.pending.size;
  }

  waitFor(
    eventId: string,
    timeoutMs: number,
    traceContext?: StartupTraceContext,
    promptId?: string,
  ): Promise<{ client_event_id: string }> {
    if (this.pending.has(eventId)) {
      throw new Error(
        `Acknowledgment waiter already exists for event "${eventId}"`,
      );
    }
    return new Promise<{ client_event_id: string }>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const commandType = this.pending.get(eventId)?.commandType;
        if (commandType) observe(this.diagnostics, "transport.command", { type: commandType, phase: "timeout", commandId: eventId });
        this.pending.delete(eventId);
        traceAckRegistry("ack.timeout", {
          clientEventId: eventId,
          pendingCount: this.pending.size,
          errorType: "AckTimeoutError",
          ...traceContext,
        });
        reject(new AckTimeoutError(eventId));
      }, timeoutMs);
      this.pending.set(eventId, { resolve, reject, timer, traceContext, promptId });
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
    if (waiter.commandType) observe(this.diagnostics, "transport.command", { type: waiter.commandType, phase: "ack", commandId: event.client_event_id, ...(waiter.promptId ? { promptId: waiter.promptId } : {}) });
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
    if (waiter.commandType) observe(this.diagnostics, "transport.command", { type: waiter.commandType, phase: "rejected", commandId: event.client_event_id });
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
      if (waiter.commandType) observe(this.diagnostics, "transport.command", { type: waiter.commandType, phase: "rejected", commandId: clientEventId });
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
