import { useLayoutEffect, useRef } from "react";
import type { Side } from "../conversation/Turn";
import type { SessionState } from "../session/SessionState";
import { translate, uiLocale } from "../i18n/messages";
import type { PlaybackInputState } from "../audio/AudioController";
import { languageName } from "../side/SideResolver";

/**
 * Participant-facing labels derived from authoritative session state.
 * Binding spec 1.2.1 §11.5. Active source speech wins on the source side
 * even when GPT output begins early, unless local playback blocks capture.
 */
export type ParticipantStatusLabel =
  | "DETECTING"
  | "YOUR TURN"
  | "LISTENING"
  | "WAITING"
  | "TRANSLATING"
  | "SPEAKING"
  | "PLAYBACK"
  | "PLAYBACK TAIL"
  | "PAUSED"
  | "ENDING"
  | "ENDED"
  | "ERROR";

export function deriveParticipantStatus(input: {
  sessionState: SessionState;
  inputReady: boolean;
  playbackInputState: PlaybackInputState;
  side: Side;
  sourceSpeaker?: Side;
  outputSpeaker?: Side;
  sourceActive: boolean;
  hasOutputText: boolean;
  audioOutputStarted: boolean;
}): ParticipantStatusLabel {
  if (input.sessionState === "ended") return "ENDED";
  if (input.sessionState === "suspended") {
    return "PAUSED";
  }
  if (input.sessionState === "error") {
    return "ERROR";
  }
  if (input.sessionState === "ending") {
    return "ENDING";
  }

  if (input.playbackInputState === "playing") return "PLAYBACK";
  if (input.playbackInputState === "tail") return "PLAYBACK TAIL";

  if (input.sourceActive && input.sourceSpeaker === undefined) return "DETECTING";

  const outputActive = input.hasOutputText || input.audioOutputStarted;
  const outputSpeaker = input.outputSpeaker ?? input.sourceSpeaker;
  const recipientOutputLabel: ParticipantStatusLabel = input.audioOutputStarted
    ? "SPEAKING"
    : "TRANSLATING";

  if (input.sourceActive && input.sourceSpeaker !== undefined) {
    if (input.side === input.sourceSpeaker) {
      return "LISTENING";
    }
    return outputActive && outputSpeaker !== input.side ? recipientOutputLabel : "WAITING";
  }

  if (outputActive && outputSpeaker !== undefined) {
    if (input.side === outputSpeaker) {
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
  recoveryText,
}: {
  side: Side;
  label: ParticipantStatusLabel;
  language?: string;
  recoveryText?: string;
}) {
  const guidanceRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (guidanceRef.current) guidanceRef.current.scrollTop = 0;
  }, [label, language, recoveryText]);
  const messages: Record<ParticipantStatusLabel, readonly [string, string?]> = {
    DETECTING: ["Определяю язык", "Продолжайте говорить на своём языке."],
    "YOUR TURN": ["Можно говорить", "Микрофон включён. Говорите по очереди."],
    LISTENING: ["Слушаю", "Я слушаю и записываю вашу речь."],
    WAITING: ["Подождите", "Дождитесь перевода."],
    TRANSLATING: ["Перевожу", "Дождитесь перевода."],
    SPEAKING: ["Слушайте перевод", "Дождитесь окончания озвучки."],
    PLAYBACK: ["Идёт озвучка", "Подождите. Сейчас ваша речь не записывается."],
    "PLAYBACK TAIL": ["Ещё мгновение", "Пока не говорите. Микрофон скоро включится."],
    PAUSED: ["Пауза"],
    ENDING: ["Завершаю…"],
    ENDED: ["Разговор завершён"],
    ERROR: ["Ошибка"],
  };
  const [title, detail] = messages[label];
  const hasGuidance = detail !== undefined;
  const listening = label === "YOUR TURN" || label === "LISTENING" || label === "DETECTING";
  const blocked = label === "PLAYBACK" || label === "PLAYBACK TAIL";
  // Keep this live-region node mounted so pause and resume are announced as updates.
  return (
    <div ref={guidanceRef} className={hasGuidance ? "participant-guidance" : "participant-status"}
      data-tone={hasGuidance ? (listening ? "ready" : "wait") : undefined}
      role="status" aria-atomic="true" tabIndex={hasGuidance ? 0 : undefined}
      aria-labelledby={hasGuidance ? `participant-guidance-title-${side}` : undefined}
      aria-describedby={hasGuidance ? `participant-guidance-detail-${side}` : undefined}
      data-testid={hasGuidance ? `participant-guidance-${side}` : undefined}>
      {hasGuidance ? <>
        <svg className="participant-guidance-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {listening || blocked ? <>
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
            {blocked ? <path d="M2 2l20 20" /> : null}
          </> : <path d="M9 5v14M15 5v14" />}
        </svg>
        <div className="participant-guidance-copy">
          <p id={`participant-guidance-title-${side}`} className="participant-guidance-title" data-testid={`participant-status-${side}`}>{translate(title, language)}</p>
          <p id={`participant-guidance-detail-${side}`} className="participant-guidance-detail"
            lang={recoveryText ? uiLocale(language) : undefined}
            data-testid={recoveryText ? `participant-recovery-${side}` : undefined}>{recoveryText ?? translate(detail, language)}</p>
        </div>
      </> : <>
        {label === "PAUSED" && language !== undefined ? `${languageName(language, uiLocale(language))} · ` : null}
        <span data-testid={`participant-status-${side}`}>{translate(title, language)}</span>
      </>}
    </div>
  );
}
