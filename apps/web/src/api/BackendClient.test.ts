import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendClient } from "./BackendClient";

describe("BackendClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts the SDP offer to /api/live/session and returns the parsed session", async () => {
    const responseBody = {
      session: { id: "sess_123" },
      transport: { type: "webrtc" as const, sdp: "v=0 answer-sdp" },
    };
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => responseBody,
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new BackendClient();
    const result = await client.createLiveSession("v=0 offer-sdp");

    expect(fetchMock).toHaveBeenCalledWith("/api/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: "v=0 offer-sdp" }),
    });
    expect(result).toEqual(responseBody);
  });

  it("throws with the response body text when the backend rejects the request", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: false,
          json: async () => ({}),
          text: async () => "An SDP offer is required",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new BackendClient();
    await expect(client.createLiveSession("")).rejects.toThrow(
      "An SDP offer is required",
    );
  });

  it("releases a Live session lease with an encoded session id", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await new BackendClient().releaseLiveSession("live/session-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/live/session/live%2Fsession-1",
      { method: "DELETE", signal: expect.any(AbortSignal) },
    );
  });
  it("bounds a stalled release request so its caller can retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    })));
    let error: unknown;
    const releasing = new BackendClient().releaseLiveSession("id").catch(value => { error = value; });
    await vi.advanceTimersByTimeAsync(9999); expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); expect(error).toBeInstanceOf(Error);
    await releasing;
  });

});
