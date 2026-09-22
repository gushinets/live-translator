import OpenAI from "openai";
import { SILENT_PRE_INTERPRETER_PROMPT } from "../prompts.js";

export interface LiveSessionResponse {
  session: { id: string; expires_at?: number };
  transport: { type: "webrtc"; sdp: string };
}

export interface LiveCreationContext { signal: AbortSignal; localId: string; }
export type LiveSessionCreator = (sdp: string, context?: LiveCreationContext) => Promise<LiveSessionResponse>;

export function makeLiveSessionCreator(
  client = new OpenAI({ maxRetries: 0 }),
): LiveSessionCreator {
  return async function createLiveSession(sdp: string, context?: LiveCreationContext) {
    const body = {
      session: {
        model: "gpt-live-1",
        instructions: SILENT_PRE_INTERPRETER_PROMPT,
        store: false,
        audio: { output: { voice: "marin" } },
      },
      transport: { type: "webrtc" as const, sdp },
    };
    return context ? client.live.create(body, { signal: context.signal }) : client.live.create(body);
  };
}
