export interface CreateLiveSessionResponse {
  session: { id: string };
  transport: { type: "webrtc"; sdp: string };
}

/**
 * Thin client for the trusted backend endpoint that creates a GPT-Live
 * WebRTC session. The browser never talks to OpenAI directly (binding spec
 * 1.2.1 §14.3).
 */
export class BackendClient {
  async createLiveSession(sdp: string): Promise<CreateLiveSessionResponse> {
    const response = await fetch("/api/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<CreateLiveSessionResponse>;
  }

  async releaseLiveSession(sessionId: string): Promise<void> {
    // Match the managed metadata client's 10s request budget; a hanging DELETE must be retryable.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        `/api/live/session/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", signal: controller.signal },
      );
      if (!response.ok) throw new Error(await response.text());
    } finally { clearTimeout(timer); }
  }
}
