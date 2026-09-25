import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountingBackend } from "./AccountingBackend";

type LifecycleClient = AccountingBackend & {
  pause(id: string, version: number): Promise<unknown>;
  claimResume(id: string, version: number, attemptId: string, mode: "setup" | "interpreter"): Promise<unknown>;
  completeResume(id: string, version: number, attemptId: string, startedAt: number, stage: "setup" | "interpreter"): Promise<unknown>;
  abortResume(id: string, version: number, attemptId: string, reason: "media_not_ready"): Promise<unknown>;
};

afterEach(() => vi.unstubAllGlobals());

describe("AccountingBackend lifecycle contract", () => {
  it.each([
    ["pause", "/pause", { expectedVersion: 3 }, ["conversation/id", 3]],
    ["claimResume", "/resume", { expectedVersion: 3, resumeAttemptId: "attempt-id", initialMode: "interpreter", usageIdentityVersion: 1 }, ["conversation/id", 3, "attempt-id", "interpreter"]],
    ["completeResume", "/resume/complete", { expectedVersion: 3, resumeAttemptId: "attempt-id", providerStartedObservedAt: 1234, readyStage: "interpreter" }, ["conversation/id", 3, "attempt-id", 1234, "interpreter"]],
    ["abortResume", "/resume/abort", { expectedVersion: 3, resumeAttemptId: "attempt-id", reason: "media_not_ready" }, ["conversation/id", 3, "attempt-id", "media_not_ready"]],
  ] as const)("sends %s to the server route with the exact versioned body", async (method, path, body, args) => {
    const responseBody = { conversationId: "conversation/id", version: 4, status: "paused", policy: { backgroundSessionCloseEnabled: true } };
    const fetchMock = vi.fn(async () => Response.json(responseBody));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AccountingBackend() as LifecycleClient;
    expect(client).toHaveProperty(method, expect.any(Function));
    const result = await (client[method] as (...args: unknown[]) => Promise<unknown>)(...args);
    expect(result).toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(`/api/conversations/conversation%2Fid${path}`, expect.objectContaining({
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
  });
});

it("advertises scoped usage when creating a provider attempt", async () => {
  const fetchMock = vi.fn(async () => Response.json({ session: {}, transport: {} }));
  vi.stubGlobal("fetch", fetchMock);
  const body = { sdp: "offer", liveSessionId: "attempt-id", conversationId: "conversation-id", conversationVersion: 1,
    initialMode: "setup" as const, startReason: "initial" as const };
  await new AccountingBackend().createSession(body, new AbortController().signal);
  expect(fetchMock).toHaveBeenCalledWith("/api/live/session", expect.objectContaining({
    method: "POST", body: JSON.stringify({ ...body, usageIdentityVersion: 1 }),
  }));
});
