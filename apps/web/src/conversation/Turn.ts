import type { TranscriptFragment } from "./TranscriptFragment";

/** Physical side, bound to its setup language for this session. */
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

export interface Turn {
  id: string;
  speaker: Side | undefined;
  sideSource: "unresolved" | "language" | "manual";
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
