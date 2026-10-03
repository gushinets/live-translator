import { useLayoutEffect, useRef } from "react";
import { languageName } from "../side/SideResolver";
import type { Side, Turn } from "../conversation/Turn";
import { ParticipantStatus, type ParticipantStatusLabel } from "./ParticipantStatus";
import { translate, uiLocale } from "../i18n/messages";

export function ParticipantPane({
  side,
  language,
  rotated,
  status,
  activeTurn,
  recentTurns,
  alertText,
  alertLanguage,
}: {
  side: Side;
  language?: string;
  rotated: boolean;
  status: ParticipantStatusLabel;
  activeTurn?: Turn;
  recentTurns: readonly Turn[];
  alertText?: string;
  alertLanguage?: string;
}) {
  const locale = uiLocale(language);
  const t = (text: string) => translate(text, locale);
  const languageLabel = language === undefined ? undefined : languageName(language, locale);
  const primaryText = activeTurn ? paneTextForTurn(activeTurn, side) : "";
  const author = (turn: Turn) => t(turn.speaker === side ? "Я" : "Он");
  const latest = primaryText.length > 0 ? undefined : [...recentTurns].reverse().find(entry =>
    (entry.status === "completed" || entry.status === "outputting") && paneTextForTurn(entry, side).length > 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && followEnd.current) scroll.scrollTop = scroll.scrollHeight;
  }, [primaryText, recentTurns]);

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
      <div className="participant-header">
        {languageLabel !== undefined ? <span className="participant-language">{languageLabel}</span> : null}
        <ParticipantStatus side={side} label={status} language={locale} />
      </div>
      <div className="participant-scroll" ref={scrollRef} tabIndex={0} role="region"
        aria-label={t("Реплики участника {side}").replace("{side}", side)}
        data-testid={`participant-scroll-${side}`}
        onScroll={event => {
          const scroll = event.currentTarget;
          followEnd.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
        }}>
      {alertText !== undefined ? (
        <p className="participant-alert" lang={alertLanguage} role="alert" data-testid={`participant-alert-${side}`}>
          {alertText}
        </p>
      ) : null}
      <ol className="participant-recent">
        {recentTurns.filter(entry => (!entry.translationOnly || entry.speaker !== side) &&
          (paneTextForTurn(entry, side).length > 0 || !["failed", "discarded"].includes(entry.status))).map((entry) => {
          const text = paneTextForTurn(entry, side);
          return (
            <li key={entry.id} className={`recent-turn${entry === latest ? " recent-turn--latest" : ""}`}>
              {entry.speaker !== undefined ? <span className="turn-author">{author(entry)}: </span> : null}
              {text.length > 0
                ? <span className={`recent-turn-primary${entry === latest ? " current-message" : ""}`}
                  data-testid={entry === latest ? `latest-primary-${side}` : undefined}
                  lang={entry.languages?.[side] ?? language}>{text}</span>
                : <span className="turn-waiting">{t("Ожидание")}</span>}
            </li>
          );
        })}
      </ol>
      {activeTurn ? (
        <div className="current-turn">
          {activeTurn.speaker !== undefined ? <span className="turn-author" data-testid={`current-author-${side}`}>{author(activeTurn)}: </span> : null}
          {primaryText.length > 0 ? <span
            className="current-message"
            lang={activeTurn.languages?.[side] ?? language}
            data-testid={`current-primary-${side}`}
          >
            {primaryText}
          </span> : <span className="turn-waiting" role="status">{t("Ожидание")}</span>}
        </div>
      ) : null}
      </div>
    </section>
  );
}

function paneTextForTurn(entry: Turn, side: Side): string {
  if (entry.speaker === undefined) return entry.translationOnly ? (entry.translatedText ?? "")
    : entry.status === "failed" ? entry.originalText : "";
  return entry.speaker === side ? entry.originalText : (entry.translatedText ?? "");
}
