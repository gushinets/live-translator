import { useCallback, useLayoutEffect, useRef } from "react";
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const scrollState = useRef({ readingTop: 0, appliedTop: 0 });
  const syncScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = followEnd.current ? scroll.scrollHeight : scrollState.current.readingTop;
    scrollState.current.appliedTop = scroll.scrollTop;
  }, []);
  useLayoutEffect(() => {
    if (followEnd.current) syncScroll();
  }, [captions, status, syncScroll]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncScroll);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [syncScroll]);

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
      <ParticipantStatus side={side} label={status} language={language} />
      <div className="participant-scroll" ref={scrollRef} tabIndex={0} role="region"
        aria-label={t("Реплики участника {side}").replace("{side}", side)}
        data-testid={`participant-scroll-${side}`}
        onScroll={event => {
          const scroll = event.currentTarget;
          const previous = scrollState.current;
          // Layout clamping and our own scroll writes must not re-enable auto-follow.
          const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
          if (scroll.scrollTop === Math.min(Math.max(0, previous.appliedTop), maximum)) return;
          previous.readingTop = scroll.scrollTop;
          previous.appliedTop = scroll.scrollTop;
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
