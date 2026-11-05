import OpenAI from "openai";
import { Agent as HttpAgent, globalAgent as httpAgent } from "node:http";
import { Agent as HttpsAgent, globalAgent as httpsAgent } from "node:https";
import { SidebandWS } from "openai/resources/live/sideband/ws";
import type { OrphanCloser } from "../accounting/CleanupWorker.js";

/** Transient orphan recovery only. Undocumented 404/transport close never means terminal. */
export function makeOrphanCloser(client?: OpenAI, timeoutMs = 15000): OrphanCloser {
  return (providerId, signal) => new Promise(resolve => {
    if (signal.aborted) { resolve({ kind: "retryable_error", code: "cancelled" }); return; }
    let done = false;
    let channel: SidebandWS | undefined;
    let ownedAgent: HttpAgent | undefined;
    let ownedSocket: ReturnType<HttpAgent["createConnection"]>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: Parameters<typeof resolve>[0]) => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort);
      resolve(result);
      if (channel) { channel.close(); channel.socket.platformSocket.terminate(); }
      ownedAgent?.destroy();
      ownedSocket?.destroy();
    };
    const abort = () => finish({ kind: "retryable_error", code: "cancelled" });
    signal.addEventListener("abort", abort, { once: true });
    try {
      const api = client ?? new OpenAI({ maxRetries: 0 });
      const http = new URL(api.baseURL).protocol === "http:";
      // --env-file can enable proxying after Node creates its global agents. ws also
      // bypasses the default agent, so initialize and pass one explicitly after env loading.
      if (process.env.NODE_USE_ENV_PROXY === "1") {
        ownedAgent = http ? new HttpAgent({ proxyEnv: process.env }) : new HttpsAgent({ proxyEnv: process.env });
        const createConnection = ownedAgent.createConnection.bind(ownedAgent);
        // CONNECT/TLS sockets are not in the agent pool until the tunnel is ready.
        ownedAgent.createConnection = (options, callback) => {
          ownedSocket = createConnection(options, callback);
          return ownedSocket;
        };
      }
      const agent = ownedAgent ?? (http ? httpAgent : httpsAgent);
      channel = new SidebandWS(api, { session_id: providerId }, { reconnect: null, agent });
      channel.on("error", () => finish({ kind: "retryable_error", code: "sideband_error" }));
      channel.on("close", () => finish({ kind: "retryable_error", code: "transport_closed" }));
      channel.socket.platformSocket.on("unexpected-response", (_req, response) => {
        response.resume();
        finish(response.statusCode === 401 || response.statusCode === 403 ? { kind: "blocked_auth_config", code: "unauthorized" }
          : { kind: "retryable_error", code: `http_${response.statusCode ?? "unknown"}` });
      });
      channel.on("session.closed", event => finish({ kind: "closed_observed", observation: {
        ...(typeof event.usage?.seconds === "number" ? { seconds: event.usage.seconds } : {}),
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
      } }));
      timer = setTimeout(() => finish({ kind: "retryable_error", code: "close_timeout" }), timeoutMs);
      channel.send({ type: "session.close" });
    } catch { finish({ kind: "blocked_auth_config", code: "sideband_configuration" }); }
  });
}
