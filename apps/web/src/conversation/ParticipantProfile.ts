import type { Side } from "./Turn";

/** Languages are detected from separate setup samples and fixed for the session. */
export interface ParticipantProfile {
  side: Side;
  language?: string;
  hasAcceptedConversationSpeech: boolean;
}
