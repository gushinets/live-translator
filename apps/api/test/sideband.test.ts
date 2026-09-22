import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { makeOrphanCloser } from "../src/openai/closeOrphanSession.js";
const servers: WebSocketServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { for (const client of server.clients) client.terminate(); await new Promise<void>(r => server.close(() => r())); } });
async function fixture() {
  const server = new WebSocketServer({ port: 0 }); servers.push(server); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Unexpected address");
  return { server, closer: makeOrphanCloser(new OpenAI({ apiKey: "local-fake-key", maxRetries: 0, baseURL: `http://127.0.0.1:${address.port}/v1` }), 100) };
}
describe("pinned SDK transient sideband", () => {
  it("uses the WebRTC attach route and persists only close metadata", async () => {
    const { server, closer } = await fixture(); let path = "";
    server.on("connection", (socket, req) => { path = req.url!; socket.on("message", payload => {
      expect(JSON.parse(payload.toString()).type).toBe("session.close");
      socket.send(JSON.stringify({ type: "session.closed", session: { id: "known", instructions: "private" }, reason: "client_request", usage: { seconds: 17 } }));
    }); });
    const result = await closer("known", new AbortController().signal);
    expect(path).toContain("/live/sessions/known/attach");
    expect(result).toEqual({ kind: "closed_observed", observation: { seconds: 17, reason: "client_request" } });
  });
  it("does not invent closure on timeout", async () => {
    const { closer } = await fixture(); expect(await closer("silent", new AbortController().signal)).toEqual({ kind: "retryable_error", code: "close_timeout" });
  });
});
