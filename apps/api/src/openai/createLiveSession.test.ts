import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { SILENT_PRE_INTERPRETER_PROMPT } from "../prompts.js";
import { makeLiveSessionCreator } from "./createLiveSession.js";

describe("makeLiveSessionCreator", () => {
  it("uses the trusted silent pre-interpreter configuration", async () => {
    const liveCreate = vi.fn().mockResolvedValue({
      session: { id: "session-1" },
      transport: { type: "webrtc", sdp: "answer-sdp" },
    });
    const client = {
      live: { create: liveCreate },
    } as unknown as OpenAI;

    await makeLiveSessionCreator(client)("v=0\r\n...");

    expect(liveCreate).toHaveBeenCalledWith({
      session: {
        model: "gpt-live-1",
        instructions: SILENT_PRE_INTERPRETER_PROMPT,
        store: false,
        audio: { output: { voice: "marin" } },
      },
      transport: { type: "webrtc", sdp: "v=0\r\n..." },
    });
  });
});
