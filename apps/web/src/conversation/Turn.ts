import type { TranscriptFragment } from "./TranscriptFragment";

/**
 * Physical, fixed side. `A` is the phone-owner/lower-half side, `B` is the
 * opposite/upper-half side. Binding spec 1.2.1 §7.1. A participant does not
 * become the other side because of language choice, and language is never
 * used as a speaker-identity signal.
 */
export type Side = "A" | "B";

/**
 * Turn lifecycle status. Binding spec 1.2.1 §12.2.
 *
 * - `streaming`: source fragments are still accumulating;
 * - `outputting`: source may be idle and interpretation text/audio is still settling;
 * - `completed`: the §10 completion predicate succeeded;
 * - `correcting`: last-turn side correction is in progress;
 * - `discarded`: an unfinished turn was abandoned (suspension/cancel/recovery) and must not be resumed;
 * - `failed`: the turn could not produce a trustworthy usable result and requires retry/repeat UI.
 */
export type TurnStatus =
  | "streaming"
  | "outputting"
  | "completed"
  | "correcting"
  | "discarded"
  | "failed";

/**
 * A single conversation turn. Binding spec 1.2.1 §12.2.
 *
 * Intentionally excludes `sourceLanguage`, `targetLanguage`, and any
 * confidence score: MVP v1.2.1 has no concrete implemented detector that
 * produces those values.
 */
export interface Turn {
  id: string;
  speaker: Side;
  sideSource: "prior" | "manual" | "acoustic_optional";
  sourceFragments: TranscriptFragment[];
  originalText: string;
  translatedText?: string;
  status: TurnStatus;
  corrected: boolean;

  speechStartAtMs?: number;
  sourceIdleAtMs?: number;
  firstOutputTextAtMs?: number;
  firstAudibleOutputAtMs?: number;
  outputTextEndAtMs?: number;
  audioOutputStarted: boolean;
  playbackEndAtMs?: number;
  turnCompletedAtMs?: number;
}
