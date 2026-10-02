import type { Side } from "../conversation/Turn";
import type { SessionState } from "../session/SessionState";
import { translate } from "../i18n/messages";

/**
 * Participant-facing labels derived from authoritative session state.
 * Binding spec 1.2.1 §11.5. Active source speech wins on the source side
 * even when GPT output begins early.
 */
export type ParticipantStatusLabel =
  | "DETECTING"
  | "YOUR TURN"
  | "LISTENING"
  | "WAITING"
  | "TRANSLATING"
  | "SPEAKING"
  | "PAUSED"
  | "ERROR";

export function deriveParticipantStatus(input: {
  sessionState: SessionState;
  inputReady: boolean;
  side: Side;
  sourceSpeaker?: Side;
  sourceActive: boolean;
  hasOutputText: boolean;
  audioOutputStarted: boolean;
}): ParticipantStatusLabel {
  if (input.sessionState === "suspended") {
    return "PAUSED";
  }
  if (input.sessionState === "error") {
    return "ERROR";
  }
  if (input.sessionState === "ending") {
    return "WAITING";
  }

  if (input.sourceActive && input.sourceSpeaker === undefined) return "DETECTING";

  const outputActive = input.hasOutputText || input.audioOutputStarted;
  const recipientOutputLabel: ParticipantStatusLabel = input.audioOutputStarted
    ? "SPEAKING"
    : "TRANSLATING";

  if (input.sourceActive && input.sourceSpeaker !== undefined) {
    if (input.side === input.sourceSpeaker) {
      return "LISTENING";
    }
    return outputActive ? recipientOutputLabel : "WAITING";
  }

  if (outputActive && input.sourceSpeaker !== undefined) {
    if (input.side === input.sourceSpeaker) {
      return "WAITING";
    }
    return recipientOutputLabel;
  }

  if (input.inputReady) {
    return "YOUR TURN";
  }
  return "WAITING";
}

export function ParticipantStatus({
  side,
  label,
  language,
}: {
  side: Side;
  label: ParticipantStatusLabel;
  language?: string;
}) {
  const visibleLabel: Record<ParticipantStatusLabel, string> = {
    DETECTING: "Определяю язык",
    "YOUR TURN": "Говорите",
    LISTENING: "Слушаю",
    WAITING: "Ожидание",
    TRANSLATING: "Перевожу",
    SPEAKING: "Перевод",
    PAUSED: "Пауза",
    ERROR: "Ошибка",
  };

  return (
    <span className="participant-status" role="status" data-testid={`participant-status-${side}`}>
      {translate(visibleLabel[label], language)}
    </span>
  );
}
