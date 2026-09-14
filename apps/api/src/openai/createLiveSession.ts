import OpenAI from "openai";
import { SILENT_PRE_INTERPRETER_PROMPT } from "../prompts.js";

export interface LiveSessionResponse {
  session: { id: string };
  transport: { type: "webrtc"; sdp: string };
}

export type LiveSessionCreator = (sdp: string) => Promise<LiveSessionResponse>;

export function makeLiveSessionCreator(
  client = new OpenAI({ maxRetries: 0 }),
): LiveSessionCreator {
  return async function createLiveSession(sdp: string) {
    return client.live.create({
      session: {
        model: "gpt-live-1",
        instructions: SILENT_PRE_INTERPRETER_PROMPT,
        store: false,
        audio: { output: { voice: "marin" } },
      },
      transport: { type: "webrtc", sdp },
    });
  };
}
