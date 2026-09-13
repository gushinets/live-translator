import type { Side, Turn } from "../conversation/Turn";
import { ParticipantStatus, type ParticipantStatusLabel } from "./ParticipantStatus";

const CURRENT_MESSAGE_SIZE_CLASSES = [
  { maxChars: 48, className: "current-message--xl" },
  { maxChars: 96, className: "current-message--lg" },
  { maxChars: 160, className: "current-message--md" },
  { maxChars: 280, className: "current-message--sm" },
] as const;

export function currentMessageSizeClass(characterLength: number): string {
  for (const entry of CURRENT_MESSAGE_SIZE_CLASSES) {
    if (characterLength <= entry.maxChars) {
      return entry.className;
    }
  }
  return "current-message--xs";
}

export function ParticipantPane({
  side,
  rotated,
  status,
  isSourceSide,
  originalText,
  translatedText,
  recentTurns,
  onTap,
  alertText,
}: {
  side: Side;
  rotated: boolean;
  status: ParticipantStatusLabel;
  isSourceSide: boolean;
  originalText: string;
  translatedText: string;
  recentTurns: readonly Turn[];
  onTap: () => void;
  alertText?: string;
}) {
  const primaryText = isSourceSide ? originalText : translatedText;
  const secondaryText = isSourceSide ? translatedText : originalText;

  return (
    <section
      className={`participant-pane${rotated ? " participant-pane--rotated" : ""}`}
      data-testid={`participant-pane-${side}`}
      aria-label={`Participant ${side}`}
      style={
        rotated
          ? { transform: "rotate(180deg)", overflow: "hidden" }
          : { overflow: "hidden" }
      }
      onClick={onTap}
    >
      <ParticipantStatus side={side} label={status} />
      {alertText !== undefined ? (
        <p className="participant-alert" role="alert" data-testid={`participant-alert-${side}`}>
          {alertText}
        </p>
      ) : null}
      <ol className="participant-recent">
        {recentTurns.map((entry) => {
          const texts = paneTextsForTurn(entry, side);
          return (
            <li key={entry.id} className="recent-turn">
              <span className="recent-turn-primary">{texts.primary}</span>
              {texts.secondary.length > 0 ? (
                <span className="recent-turn-secondary">{texts.secondary}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {primaryText.length > 0 ? (
        <p
          className={`current-message ${currentMessageSizeClass(primaryText.length)}`}
          data-testid={`current-primary-${side}`}
        >
          {primaryText}
        </p>
      ) : null}
      {secondaryText.length > 0 ? (
        <p className="current-secondary" data-testid={`current-secondary-${side}`}>
          {secondaryText}
        </p>
      ) : null}
    </section>
  );
}

function paneTextsForTurn(entry: Turn, side: Side): { primary: string; secondary: string } {
  const isSource = entry.speaker === side;
  return {
    primary: isSource ? entry.originalText : (entry.translatedText ?? ""),
    secondary: isSource ? (entry.translatedText ?? "") : entry.originalText,
  };
}
