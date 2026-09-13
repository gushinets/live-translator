import type { Side } from "../conversation/Turn";

/**
 * Initial expected speaker before any turn has completed. Binding spec
 * 1.2.1 §7.4: "Initial expected speaker is A."
 */
export const INITIAL_EXPECTED_SPEAKER: Side = "A";

/**
 * SideResolver v1.2 (binding spec 1.2.1 §7.3). Three mechanisms are used,
 * in priority order:
 *
 * 1. manual tap — absolute authority (`manualOverride`);
 * 2. expected alternation — primary automatic heuristic (`expected`,
 *    produced by {@link nextExpectedSpeaker});
 * 3. optional acoustic hint — see {@link AcousticSideHintStrategy}, which
 *    is intentionally left unimplemented. MVP v1.2.1 has no diarization.
 *
 * Language is never used as an identity signal here.
 */
export function resolveSide(expected: Side, manualOverride?: Side): Side {
  return manualOverride ?? expected;
}

/**
 * Expected-alternation prior (binding spec 1.2.1 §7.4): after A completes a
 * turn, expect B; after B, expect A. This is a prior only — one participant
 * may legitimately speak twice in a row.
 */
export function nextExpectedSpeaker(completedSpeaker: Side): Side {
  return completedSpeaker === "A" ? "B" : "A";
}

/**
 * Optional acoustic hint strategy (binding spec 1.2.1 §7.3, item 3).
 *
 * No implementation exists in MVP v1.2.1: the PWA does not depend on
 * reliable multi-microphone/beamforming input, and recent semantic content
 * must not be used to fake speaker diarization. This interface exists only
 * so a future, evidence-backed detector has a defined seam to plug into
 * {@link resolveSide} callers without inventing one now.
 */
export interface AcousticSideHintStrategy {
  /** Returns a hinted side, or `undefined` if no usable signal exists. */
  estimateSide(): Side | undefined;
}
