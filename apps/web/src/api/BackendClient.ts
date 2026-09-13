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
}
