import type { TranscriptFragment } from "./TranscriptFragment";
import type { ConversationLanguages } from "../side/SideResolver";

/** Physical side, bound to its setup language for this session. */
export type Side = "A" | "B";

/**
 * Turn lifecycle status. Binding spec 1.2.1 §12.2.
 *
 * - `streaming`: source fragments are still accumulating;
 * - `outputting`: source may be idle and interpretation text/audio is still settling;
 * - `completed`: the §10 completion predicate succeeded;
 * - `discarded`: an unfinished turn was abandoned (suspension/cancel/recovery) and must not be resumed;
 * - `failed`: the turn could not produce a trustworthy usable result and requires retry/repeat UI.
 */
export type TurnStatus =
  | "streaming"
  | "outputting"
  | "completed"
  | "discarded"
  | "failed";

export interface Turn {
  id: string;
  speaker: Side | undefined;
  sideSource: "unresolved" | "language" | "translation";
  /** Fixed display languages for this utterance, retained after setup changes. */
  languages?: ConversationLanguages;
  sourceFragments: TranscriptFragment[];
  originalText: string;
  translatedText?: string;
  status: TurnStatus;

  speechStartAtMs?: number;
  sourceIdleAtMs?: number;
  firstOutputTextAtMs?: number;
  firstAudibleOutputAtMs?: number;
  outputTextEndAtMs?: number;
  audioOutputStarted: boolean;
  playbackEndAtMs?: number;
  turnCompletedAtMs?: number;
}
