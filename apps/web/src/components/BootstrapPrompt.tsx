import type { Side } from "../conversation/Turn";
import type { Ref } from "react";
import { languageName } from "../side/SideResolver";
import { translate, uiLocale } from "../i18n/messages";

/** Two separate speech samples establish the fixed language pair. */
export function BootstrapPrompt({
  transcript, side, recording, languageA, languageB, language,
  onRecord, onAccept, onBegin, actionsDisabled = false, primaryActionRef, repeatActionRef,
}: {
  transcript: string;
  side: Side;
  recording: boolean;
  languageA?: string;
  languageB?: string;
  language?: string;
  onRecord: () => void;
  onAccept: () => void;
  onBegin: () => void;
  actionsDisabled?: boolean;
  primaryActionRef?: Ref<HTMLButtonElement>;
  repeatActionRef?: Ref<HTMLButtonElement>;
}) {
  const ready = languageA !== undefined && languageB !== undefined;
  const locale = uiLocale(language ?? languageA);
  const t = (text: string) => translate(text, locale).replace("{side}", side).replace("{step}", side === "A" ? "1" : "2");
  return (
    <section className="bootstrap-prompt" aria-labelledby="bootstrap-title" aria-busy={actionsDisabled}>
      <div className="bootstrap-status" role="status" aria-live="polite">
        <span className="bootstrap-status-dot" aria-hidden="true" />
        {t(actionsDisabled ? (ready ? "Запускаю перевод…" : "Сохраняю образец…")
          : ready ? "Языки закреплены" : recording ? "Слушаю участника {side}" : "Очередь участника {side}")}
      </div>
      <div className="bootstrap-copy">
        <h2 id="bootstrap-title" className="bootstrap-title">
          {t(ready ? "Можно начинать" : "Образец речи {side} · {step} из 2")}
        </h2>
        <p className="bootstrap-description">
          {t(ready ? "Говорите в любом порядке. Переводчик определит сторону по языку."
            : "Произнесите полное предложение на своём языке. Не называйте язык — просто расскажите что-нибудь.")}
        </p>
      </div>
      {languageA !== undefined ? <p>{translate("Участник {side}", locale).replace("{side}", "A")} — {languageName(languageA, locale)}</p> : null}
      {languageB !== undefined ? <p>{translate("Участник {side}", locale).replace("{side}", "B")} — {languageName(languageB, locale)}</p> : null}
      {transcript.length > 0 ? (
        <div className="bootstrap-hint" aria-live="polite">
          <p className="bootstrap-hint-label">{t("Распознано")}</p>
          <p className="bootstrap-hint-value">{transcript}</p>
        </div>
      ) : !ready && recording ? <div className="bootstrap-waiting">{t("Жду вашу фразу…")}</div> : null}
      <div className="bootstrap-actions">
        <button ref={primaryActionRef} className="setup-primary-action" type="button"
          disabled={actionsDisabled || (!ready && recording && transcript.trim().length === 0)}
          onClick={ready ? onBegin : recording ? onAccept : onRecord}>
          {t(ready ? "Начать разговор" : recording ? "Сохранить образец" : "Записать образец {side}")}
        </button>
        {!ready && recording ? (
          <button ref={repeatActionRef} className="setup-secondary-action" type="button" disabled={actionsDisabled} onClick={onRecord}>
            {t("Записать заново")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
