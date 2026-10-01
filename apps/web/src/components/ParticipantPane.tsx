import { languageName } from "../side/SideResolver";
import type { Side, Turn } from "../conversation/Turn";
import { ParticipantStatus, type ParticipantStatusLabel } from "./ParticipantStatus";
import { translate, uiLocale } from "../i18n/messages";

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
  language,
  rotated,
  status,
  activeTurn,
  recentTurns,
  onTap,
  alertText,
  alertLanguage,
}: {
  side: Side;
  language?: string;
  rotated: boolean;
  status: ParticipantStatusLabel;
  activeTurn?: Turn;
  recentTurns: readonly Turn[];
  onTap: () => void;
  alertText?: string;
  alertLanguage?: string;
}) {
  const locale = uiLocale(language);
  const t = (text: string) => translate(text, locale);
  const primaryText = activeTurn ? paneTextForTurn(activeTurn, side) : "";
  const author = (turn: Turn) => t(turn.speaker === side ? "Я" : "Он");

  return (
    <section
      className={`participant-pane${rotated ? " participant-pane--rotated" : ""}`}
      data-testid={`participant-pane-${side}`}
      lang={locale}
      aria-label={t("Участник {side}").replace("{side}", side)}
      style={
        rotated
          ? { transform: "rotate(180deg)", overflow: "hidden" }
          : { overflow: "hidden" }
      }
    >
      <button
        className="participant-correction-target"
        type="button"
        aria-label={t("Исправить: говорил участник {side}").replace("{side}", side)}
        onClick={onTap}
      />
      {language !== undefined ? <p className="participant-language">{side} · {languageName(language, locale)}</p> : null}
      <ParticipantStatus side={side} label={status} language={locale} />
      {alertText !== undefined ? (
        <p className="participant-alert" lang={alertLanguage} role="alert" data-testid={`participant-alert-${side}`}>
          {alertText}
        </p>
      ) : null}
      <ol className="participant-recent">
        {recentTurns.map((entry) => {
          const text = paneTextForTurn(entry, side);
          return (
            <li key={entry.id} className="recent-turn">
              {text.length > 0 ? <>
                <span className="turn-author">{author(entry)}:</span>
                <span className="recent-turn-primary">{text}</span>
              </> : <span className="turn-waiting">{t("ОЖИДАНИЕ")}</span>}
            </li>
          );
        })}
      </ol>
      {primaryText.length > 0 && activeTurn ? (
        <div className="current-turn">
          <span className="turn-author" data-testid={`current-author-${side}`}>{author(activeTurn)}:</span>
          <p
            className={`current-message ${currentMessageSizeClass(primaryText.length)}`}
            lang={language}
            data-testid={`current-primary-${side}`}
          >
            {primaryText}
          </p>
        </div>
      ) : activeTurn ? <p className="turn-waiting" role="status">{t("ОЖИДАНИЕ")}</p> : null}
    </section>
  );
}

function paneTextForTurn(entry: Turn, side: Side): string {
  if (entry.speaker === undefined) return "";
  return entry.speaker === side ? entry.originalText : (entry.translatedText ?? "");
}
