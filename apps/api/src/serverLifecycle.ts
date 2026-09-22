import type { Express } from "express";
import type { Server } from "node:http";
import type { LedgerRuntime } from "./accounting/LedgerRuntime.js";

export interface ApiServerLifecycle {
  server: Server;
  shutdown(): Promise<void>;
}
/** Single absolute budget for network create drain, cleanup worker, HTTP and database. */
export function startApiServer(app: Express, options: { port: number; host?: string; drainMs: number; timeoutMs: number }): ApiServerLifecycle {
  const runtime = app.locals.ledgerRuntime as LedgerRuntime | undefined;
  const server = app.listen(options.port, options.host ?? "0.0.0.0");
  let shutdown: Promise<void> | undefined;
  const stop = async () => {
    const deadline = performance.now() + options.timeoutMs;
    // Calling this async method closes the dispatch gate synchronously, before its first await.
    const runtimeStop = runtime?.shutdown({ drainMs: options.drainMs, timeoutMs: Math.max(0, deadline - performance.now()) });
    const httpClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeIdleConnections();
    let failure: unknown;
    try { await runtimeStop; } catch (error) { failure = error; }
    // Never keep a disconnected client socket alive after the bounded provider handoff/drain.
    server.closeAllConnections();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("API shutdown deadline reached");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([httpClosed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("HTTP shutdown deadline reached")), remaining); })]);
    } finally { if (timer) clearTimeout(timer); }
    if (runtime?.ledger.db.isOpen) runtime.ledger.db.close();
    if (failure) throw failure;
  };
  return { server, shutdown: () => { shutdown ??= stop(); return shutdown; } };
}

export function installShutdownSignals(lifecycle: ApiServerLifecycle, timeoutMs: number): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const guard = setTimeout(() => {
      console.error("API shutdown exceeded its absolute budget; durable recovery is required");
      process.exit(1);
    }, timeoutMs);
    void lifecycle.shutdown().then(() => {
      clearTimeout(guard); process.exit(0);
    }, () => {
      clearTimeout(guard); console.error("API shutdown incomplete; durable recovery is required"); process.exit(1);
    });
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
