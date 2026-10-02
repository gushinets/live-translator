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
  const latest = primaryText.length > 0 ? undefined : [...recentTurns].reverse().find(entry =>
    entry.status === "completed" && paneTextForTurn(entry, side).length > 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const pointerStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const pointerMoved = useRef(false);
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
      onPointerDown={event => {
        const scroll = scrollRef.current;
        const bounds = scroll?.getBoundingClientRect();
        const scrollbar = scroll !== null && event.target === scroll && bounds !== undefined &&
          (rotated ? bounds.right - event.clientX : event.clientX - bounds.left) >= scroll.clientWidth;
        pointerMoved.current = scrollbar;
        pointerStart.current = event.isPrimary && event.button === 0 && !scrollbar ? { x: event.clientX, y: event.clientY } : undefined;
      }}
      onPointerMove={event => {
        const start = pointerStart.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
          pointerStart.current = undefined;
          pointerMoved.current = true;
        }
      }}
      onPointerCancel={() => { pointerStart.current = undefined; pointerMoved.current = true; }}
      onPointerUp={event => {
        const start = pointerStart.current;
        pointerStart.current = undefined;
        if (start && !(event.target as Element).closest("button") &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8 &&
          window.getSelection()?.isCollapsed !== false) onTap();
      }}
    >
      <button
        className="participant-correction-target"
        type="button"
        aria-label={t("Исправить: говорил участник {side}").replace("{side}", side)}
        onClick={event => {
          if (event.detail === 0 || (!pointerMoved.current && window.getSelection()?.isCollapsed !== false)) onTap();
        }}
      >
        {language !== undefined ? <span className="participant-language">{side} · {languageName(language, locale)}</span> : null}
        <ParticipantStatus side={side} label={status} language={locale} />
      </button>
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
        {recentTurns.map((entry) => {
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
  if (entry.speaker === undefined) return "";
  return entry.speaker === side ? entry.originalText : (entry.translatedText ?? "");
}
