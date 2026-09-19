import type { ParticipantProfile } from "../conversation/ParticipantProfile";
import type { Side, Turn } from "../conversation/Turn";

export type SessionState =
  | "idle"
  | "connecting"
  | "context"
  | "bootstrap"
  | "listening"
  | "outputting"
  | "correcting"
  | "suspended"
  | "error"
  | "ending"
  | "ended";

/**
 * The full session record. Binding spec 1.2.1 §12.3.
 */
export interface TranslationSession {
  state: SessionState;
  contextText: string;
  activeTurn?: Turn;
  recentTurns: Turn[];
  lastSpeaker?: Side;
  participantA: ParticipantProfile;
  participantB: ParticipantProfile;
}

export function createInitialSession(
  participantA: ParticipantProfile,
  participantB: ParticipantProfile,
): TranslationSession {
  return {
    state: "idle",
    contextText: "",
    recentTurns: [],
    participantA,
    participantB,
  };
}
