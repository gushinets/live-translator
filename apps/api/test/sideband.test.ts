import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { globalAgent as httpsAgent } from "node:https";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { makeOrphanCloser } from "../src/openai/closeOrphanSession.js";
const servers: WebSocketServer[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { for (const client of server.clients) client.terminate(); await new Promise<void>(r => server.close(() => r())); } });
async function fixture() {
  const server = new WebSocketServer({ port: 0 }); servers.push(server); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Unexpected address");
  return { server, closer: makeOrphanCloser(new OpenAI({ apiKey: "local-fake-key", maxRetries: 0, baseURL: `http://127.0.0.1:${address.port}/v1` }), 100) };
}
describe("pinned SDK transient sideband", () => {
  it("routes HTTPS sideband through Node's configured global agent", async () => {
    vi.stubEnv("NODE_USE_ENV_PROXY", "0");
    // Keep the real SDK/ws request construction, but prevent all network traffic.
    const directTls = vi.spyOn(tls, "connect").mockImplementation(() => { throw new Error("Unexpected direct TLS"); });
    const agentConnect = vi.spyOn(httpsAgent, "createConnection").mockImplementation(() => { throw new Error("Offline agent probe"); });
    const closer = makeOrphanCloser(new OpenAI({ apiKey: "local-fake-key", maxRetries: 0,
      baseURL: "https://provider.invalid/v1" }), 100);
    await closer("known", new AbortController().signal);
    expect(agentConnect).toHaveBeenCalledOnce();
    expect(directTls).not.toHaveBeenCalled();
  });
  it("honors NO_PROXY when the environment proxy is enabled", async () => {
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    for (const key of ["HTTPS_PROXY", "https_proxy"]) vi.stubEnv(key, "http://127.0.0.1:1");
    for (const key of ["NO_PROXY", "no_proxy"]) vi.stubEnv(key, "provider.invalid");
    const directTls = vi.spyOn(tls, "connect").mockImplementation(() => { throw new Error("Offline direct TLS probe"); });
    const proxyConnect = vi.spyOn(net, "connect").mockImplementation(() => { throw new Error("Unexpected proxy connection"); });
    const closer = makeOrphanCloser(new OpenAI({ apiKey: "local-fake-key", maxRetries: 0,
      baseURL: "https://provider.invalid/v1" }), 100);
    await closer("known", new AbortController().signal);
    expect(directTls).toHaveBeenCalledOnce();
    expect(proxyConnect).not.toHaveBeenCalled();
  });
  it("inherits global proxy and TLS options without changing the shared agent", async () => {
    vi.stubEnv("NODE_USE_ENV_PROXY", "0");
    const options = { ...httpsAgent.options, servername: "configured.invalid",
      proxyEnv: { HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "provider.invalid" } };
    vi.spyOn(httpsAgent, "createConnection").mockImplementation(() => { throw new Error("Unexpected shared agent use"); });
    const sharedDestroy = vi.spyOn(httpsAgent, "destroy");
    const directTls = vi.spyOn(tls, "connect").mockImplementation(() => { throw new Error("Offline direct TLS probe"); });
    const proxyConnect = vi.spyOn(net, "connect").mockImplementation(() => { throw new Error("Unexpected proxy connection"); });
    const originalOptions = httpsAgent.options;
    httpsAgent.options = options;
    try {
      const closer = makeOrphanCloser(new OpenAI({ apiKey: "local-fake-key", maxRetries: 0,
        baseURL: "https://provider.invalid/v1" }), 100);
      await closer("known", new AbortController().signal);
      expect(directTls).toHaveBeenCalledWith(expect.objectContaining({ servername: "configured.invalid" }));
      expect(proxyConnect).not.toHaveBeenCalled();
      expect(httpsAgent.createConnection).not.toHaveBeenCalled();
      expect(sharedDestroy).not.toHaveBeenCalled();
      expect(httpsAgent.options).toBe(options);
    } finally { httpsAgent.options = originalOptions; }
  });
  it("routes sideband through a proxy enabled by the child's env file", async () => {
    const proxy = createServer();
    const tunnels: string[] = [];
    proxy.on("connect", (request, socket) => {
      tunnels.push(request.url!);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    const address = proxy.address(); if (!address || typeof address === "string") throw new Error("Unexpected proxy address");
    const directory = mkdtempSync(join(tmpdir(), "sideband-env-")), envFile = join(directory, ".env");
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    writeFileSync(envFile, `NODE_USE_ENV_PROXY=1\nHTTP_PROXY=${proxyUrl}\nHTTPS_PROXY=${proxyUrl}\nNO_PROXY=\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "local-fake-key" };
    for (const key of Object.keys(env)) {
      if (["http_proxy", "https_proxy", "all_proxy", "no_proxy", "node_use_env_proxy", "node_options"].includes(key.toLowerCase())) delete env[key];
    }
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["--env-file", envFile, "--import", "tsx", "--input-type=module", "--eval", `
        import OpenAI from "openai";
        import { makeOrphanCloser } from ${JSON.stringify(new URL("../src/openai/closeOrphanSession.ts", import.meta.url).href)};
        const closer = makeOrphanCloser(new OpenAI({ apiKey: "local-fake-key", maxRetries: 0,
          baseURL: ${JSON.stringify(`https://127.0.0.1:${address.port}/v1`)} }), 2000);
        console.log(JSON.stringify(await closer("known", new AbortController().signal)));
      `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, timeout: 10000 });
      expect(tunnels).toEqual([`127.0.0.1:${address.port}`]);
      expect(JSON.parse(stdout.trim())).toMatchObject({ kind: "retryable_error" });
    } finally {
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      unlinkSync(envFile); rmdirSync(directory);
    }
  });
  it.each(["environment", "CLI", "NODE_OPTIONS"].flatMap(mode => [
    [mode, "CONNECT", "timeout"], [mode, "TLS", "timeout"],
    [mode, "CONNECT", "abort"], [mode, "TLS", "abort"],
  ]))("closes a pending %s proxy %s socket on %s", async (mode, phase, stop) => {
    const proxy = createServer(), sockets = new Set<Socket>(), tunnels: string[] = [];
    let reachedPhase = false;
    proxy.on("connection", socket => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("end", () => socket.end());
      socket.once("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (request, socket) => {
      tunnels.push(request.url!);
      // Drain the TLS ClientHello and FIN without completing the handshake.
      socket.on("data", () => { reachedPhase = true; });
      socket.resume();
      if (phase === "TLS") socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      else reachedPhase = true;
    });
    proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    const address = proxy.address(); if (!address || typeof address === "string") throw new Error("Unexpected proxy address");
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "local-fake-key" };
    for (const key of Object.keys(env)) {
      if (["http_proxy", "https_proxy", "all_proxy", "no_proxy", "node_use_env_proxy", "node_options"].includes(key.toLowerCase())) delete env[key];
    }
    env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`;
    if (mode === "environment") env.NODE_USE_ENV_PROXY = "1";
    if (mode === "NODE_OPTIONS") env.NODE_OPTIONS = "--use-env-proxy";
    const child = spawn(process.execPath, [...(mode === "CLI" ? ["--use-env-proxy"] : []),
      "--import", "tsx", "--input-type=module", "--eval", `
        import OpenAI from "openai";
        import { makeOrphanCloser } from ${JSON.stringify(new URL("../src/openai/closeOrphanSession.ts", import.meta.url).href)};
        const controller = new AbortController();
        process.on("message", () => controller.abort());
        const closer = makeOrphanCloser(new OpenAI({ apiKey: "local-fake-key", maxRetries: 0,
          baseURL: "https://provider.invalid/v1" }), ${stop === "timeout" ? 250 : 2000});
        process.send(await closer("known", controller.signal));
      `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const exited = once(child, "exit");
    const results: unknown[] = [];
    child.on("message", result => results.push(result));
    try {
      await vi.waitFor(() => expect(reachedPhase).toBe(true), { timeout: 3000 });
      if (stop === "abort") child.send("abort");
      await vi.waitFor(() => expect(results).toEqual([
        { kind: "retryable_error", code: stop === "timeout" ? "close_timeout" : "cancelled" },
      ]));
      expect(tunnels).toEqual(["provider.invalid:443"]);
      await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 500 });
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill(); await exited;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });
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
