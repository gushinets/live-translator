import { useLayoutEffect, useRef } from "react";
import { languageName } from "../side/SideResolver";
import type { Side } from "../conversation/Turn";
import { ParticipantStatus, type ParticipantStatusLabel } from "./ParticipantStatus";
import { translate, uiLocale } from "../i18n/messages";
import type { DialogueBlock } from "../conversation/DialogueTranscript";
import { DialogueCaptions } from "./DialogueCaptions";

export function ParticipantPane({
  side,
  language,
  rotated,
  status,
  alertText,
  alertLanguage,
  captions,
}: {
  side: Side;
  language?: string;
  rotated: boolean;
  status: ParticipantStatusLabel;
  alertText?: string;
  alertLanguage?: string;
  captions: readonly DialogueBlock[];
}) {
  const locale = uiLocale(language);
  const t = (text: string) => translate(text, locale);
  const languageLabel = language === undefined ? undefined : languageName(language, locale);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && followEnd.current) scroll.scrollTop = scroll.scrollHeight;
  }, [captions]);

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
      <DialogueCaptions blocks={captions} language={language} />
      </div>
    </section>
  );
}
