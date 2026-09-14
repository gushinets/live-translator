import OpenAI from "openai";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const sessionResult = {
  session: { id: "session-1" },
  transport: { type: "webrtc" as const, sdp: "answer-sdp" },
};

describe("POST /api/live/session", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "server-secret";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it("rejects missing SDP", async () => {
    const response = await request(createApp())
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "An SDP offer is required" });
  });

  it("rejects blank SDP", async () => {
    const response = await request(createApp())
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "   " });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "An SDP offer is required" });
  });

  it("rejects an unexpected origin", async () => {
    const response = await request(createApp())
      .post("/api/live/session")
      .set("Origin", "https://unexpected.example")
      .send({ sdp: "v=0\r\n..." });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Unexpected request origin" });
  });

  it("rejects a missing origin", async () => {
    const response = await request(createApp())
      .post("/api/live/session")
      .send({ sdp: "v=0\r\n..." });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Unexpected request origin" });
  });

  it("rejects JSON bodies larger than 64kb", async () => {
    const response = await request(createApp())
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "x".repeat(65 * 1024) });

    expect(response.status).toBe(413);
  });

  it("rejects requests when the API key is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    const response = await request(createApp())
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "v=0\r\n..." });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Set OPENAI_API_KEY on the server",
    });
  });

  it("returns the OpenAI session result unchanged and releases the creation lease", async () => {
    const createLiveSession = vi.fn().mockResolvedValue(sessionResult);
    const release = vi.fn();
    const leaseRegistry = {
      acquire: vi.fn().mockReturnValue({ leaseId: "lease-1", release }),
    };
    const response = await request(createApp({ createLiveSession, leaseRegistry }))
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "v=0\r\n..." });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(sessionResult);
    expect(createLiveSession).toHaveBeenCalledWith("v=0\r\n...");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects the sixth concurrent session creation request", async () => {
    const pendingSessions: Array<(result: typeof sessionResult) => void> = [];
    const createLiveSession = vi.fn(
      () =>
        new Promise<typeof sessionResult>((resolve) => {
          pendingSessions.push(resolve);
        }),
    );
    const app = createApp({ createLiveSession });

    const pendingRequests = Array.from({ length: 5 }, (_, requestNumber) =>
      Promise.resolve(
        request(app)
          .post("/api/live/session")
          .set("Origin", "http://localhost:5173")
          .send({ sdp: `offer-${requestNumber}` })
          .expect(201),
      ),
    );
    await vi.waitFor(() => expect(createLiveSession).toHaveBeenCalledTimes(5));

    const response = await request(app)
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "sixth-offer" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: "Concurrent session limit reached" });
    expect(createLiveSession).toHaveBeenCalledTimes(5);

    for (const resolve of pendingSessions) resolve(sessionResult);
    await Promise.all(pendingRequests);
  });

  it("rate-limits the 21st session creation attempt from the same IP", async () => {
    const createLiveSession = vi.fn().mockResolvedValue(sessionResult);
    const leaseRegistry = {
      acquire: vi.fn().mockReturnValue({
        leaseId: "unlimited-lease",
        release: vi.fn(),
      }),
    };
    const app = createApp({ createLiveSession, leaseRegistry });

    for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
      const response = await request(app)
        .post("/api/live/session")
        .set("Origin", "http://localhost:5173")
        .send({ sdp: `offer-${requestNumber}` });
      expect(response.status).toBe(201);
    }

    const response = await request(app)
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "offer-20" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: "Too many session creation attempts",
    });
    expect(createLiveSession).toHaveBeenCalledTimes(20);
  });

  it("releases the lease when session creation fails", async () => {
    const release = vi.fn();
    const leaseRegistry = {
      acquire: vi.fn().mockReturnValue({ leaseId: "lease-1", release }),
    };
    const createLiveSession = vi.fn().mockRejectedValue(new Error("failure"));
    const logger = { error: vi.fn() };
    const app = createApp({ createLiveSession, leaseRegistry, logger });

    await request(app)
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "v=0\r\n..." });

    expect(release).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "Unexpected Live session creation failure",
      { errorType: "Error" },
    );
  });

  it("maps OpenAI API errors and logs safe upstream diagnostics", async () => {
    const apiError = new OpenAI.APIError(
      429,
      { message: "sensitive upstream message" },
      "sensitive upstream message",
      new Headers(),
    );
    const createLiveSession = vi.fn().mockRejectedValue(apiError);
    const logger = { error: vi.fn() };
    const response = await request(createApp({ createLiveSession, logger }))
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "sensitive-sdp" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: "Live session creation failed" });
    expect(logger.error).toHaveBeenCalledWith(
      "OpenAI Live session creation failed",
      {
        status: 429,
        code: undefined,
        type: undefined,
        requestId: null,
        message: "429 sensitive upstream message",
      },
    );
  });

  it("maps status-less OpenAI API errors to 502 and releases the lease", async () => {
    const release = vi.fn();
    const leaseRegistry = {
      acquire: vi.fn().mockReturnValue({ leaseId: "lease-1", release }),
    };
    const connectionError = new OpenAI.APIConnectionError({
      message: "sensitive connection failure",
    });
    const createLiveSession = vi.fn().mockRejectedValue(connectionError);
    const logger = { error: vi.fn() };
    const response = await request(
      createApp({ createLiveSession, leaseRegistry, logger }),
    )
      .post("/api/live/session")
      .set("Origin", "http://localhost:5173")
      .send({ sdp: "sensitive-sdp" });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "Live session creation failed" });
    expect(release).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "OpenAI Live session creation failed",
      {
        status: 502,
        code: undefined,
        type: undefined,
        requestId: undefined,
        message: "sensitive connection failure",
      },
    );
  });
});
