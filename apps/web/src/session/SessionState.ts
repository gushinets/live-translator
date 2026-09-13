import type { ParticipantProfile } from "../conversation/ParticipantProfile";
import type { Side, Turn } from "../conversation/Turn";
import { INITIAL_EXPECTED_SPEAKER } from "../side/SideResolver";

/**
 * The application's one authoritative session state. Binding spec 1.2.1
 * §11. The previously proposed `turn_finalizing`, `translating`,
 * `overlap`, and `low_confidence` states are intentionally NOT included:
 * MVP v1.2.1 has no reliable client detector that makes them authoritative
 * global states. Any such labels are derived elsewhere from this state
 * plus `expectedSpeaker`/turn data, not modeled as extra states here.
 */
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
  expectedSpeaker: Side;
  participantA: ParticipantProfile;
  participantB: ParticipantProfile;
}

/**
 * Builds the initial `idle` session for a fresh conversation. Per §7.4,
 * the initial expected speaker is always `A` (an explicit spec value, not
 * an invented default).
 */
export function createInitialSession(
  participantA: ParticipantProfile,
  participantB: ParticipantProfile,
): TranslationSession {
  return {
    state: "idle",
    contextText: "",
    recentTurns: [],
    expectedSpeaker: INITIAL_EXPECTED_SPEAKER,
    participantA,
    participantB,
  };
}
