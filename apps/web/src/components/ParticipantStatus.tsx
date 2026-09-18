import type { Side } from "../conversation/Turn";
import type { SessionState } from "../session/SessionState";

/**
 * Participant-facing labels derived from authoritative session state.
 * Binding spec 1.2.1 §11.5. Active source speech wins on the source side
 * even when GPT output begins early.
 */
export type ParticipantStatusLabel =
  | "YOUR TURN"
  | "LISTENING"
  | "WAITING"
  | "TRANSLATING"
  | "SPEAKING"
  | "CORRECTING"
  | "PAUSED"
  | "ERROR";

export function deriveParticipantStatus(input: {
  sessionState: SessionState;
  expectedSpeaker: Side;
  inputReady: boolean;
  side: Side;
  sourceSpeaker?: Side;
  sourceActive: boolean;
  hasOutputText: boolean;
  audioOutputStarted: boolean;
}): ParticipantStatusLabel {
  if (input.sessionState === "correcting") {
    return "CORRECTING";
  }
  if (input.sessionState === "suspended") {
    return "PAUSED";
  }
  if (input.sessionState === "error") {
    return "ERROR";
  }
  if (input.sessionState === "ending") {
    return "WAITING";
  }

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

  if (input.side === input.expectedSpeaker && input.inputReady) {
    return "YOUR TURN";
  }
  return "WAITING";
}

export function ParticipantStatus({
  side,
  label,
}: {
  side: Side;
  label: ParticipantStatusLabel;
}) {
  const visibleLabel: Record<ParticipantStatusLabel, string> = {
    "YOUR TURN": "ГОВОРИТЕ",
    LISTENING: "СЛУШАЮ",
    WAITING: "ОЖИДАНИЕ",
    TRANSLATING: "ПЕРЕВОЖУ",
    SPEAKING: "ПЕРЕВОД",
    CORRECTING: "ИСПРАВЛЯЮ",
    PAUSED: "ПАУЗА",
    ERROR: "ОШИБКА",
  };

  return (
    <p className="participant-status" data-testid={`participant-status-${side}`}>
      {visibleLabel[label]}
    </p>
  );
}
