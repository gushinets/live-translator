import type { Side } from "../conversation/Turn";
import { languageName } from "../side/SideResolver";

/** Two separate speech samples establish the fixed language pair. */
export function BootstrapPrompt({
  transcript, side, recording, languageA, languageB,
  onRecord, onAccept, onBegin, actionsDisabled = false,
}: {
  transcript: string;
  side: Side;
  recording: boolean;
  languageA?: string;
  languageB?: string;
  onRecord: () => void;
  onAccept: () => void;
  onBegin: () => void;
  actionsDisabled?: boolean;
}) {
  const ready = languageA !== undefined && languageB !== undefined;
  return (
    <section className="bootstrap-prompt" aria-labelledby="bootstrap-title" aria-busy={actionsDisabled}>
      <div className="bootstrap-status" role="status" aria-live="polite">
        <span className="bootstrap-status-dot" aria-hidden="true" />
        {actionsDisabled ? (ready ? "Запускаю перевод…" : "Сохраняю образец…")
          : ready ? "Языки закреплены" : recording ? `Слушаю участника ${side}` : `Очередь участника ${side}`}
      </div>
      <div className="bootstrap-copy">
        <h2 id="bootstrap-title" className="bootstrap-title">
          {ready ? "Можно начинать" : `Образец речи ${side} · ${side === "A" ? "1" : "2"} из 2`}
        </h2>
        <p className="bootstrap-description">
          {ready ? "Говорите в любом порядке. Переводчик определит сторону по языку."
            : "Произнесите полное предложение на своём языке. Не называйте язык — просто расскажите что-нибудь."}
        </p>
      </div>
      {languageA !== undefined ? <p>Участник A — {languageName(languageA)}</p> : null}
      {languageB !== undefined ? <p>Участник B — {languageName(languageB)}</p> : null}
      {transcript.length > 0 ? (
        <div className="bootstrap-hint" aria-live="polite">
          <p className="bootstrap-hint-label">Распознано</p>
          <p className="bootstrap-hint-value">{transcript}</p>
        </div>
      ) : !ready && recording ? <div className="bootstrap-waiting">Жду вашу фразу…</div> : null}
      <div className="bootstrap-actions">
        <button className="setup-primary-action" type="button"
          disabled={actionsDisabled || (!ready && recording && transcript.trim().length === 0)}
          onClick={ready ? onBegin : recording ? onAccept : onRecord}>
          {ready ? "Начать разговор" : recording ? "Сохранить образец" : `Записать образец ${side}`}
        </button>
        {!ready && recording ? (
          <button className="setup-secondary-action" type="button" disabled={actionsDisabled} onClick={onRecord}>
            Записать заново
          </button>
        ) : null}
      </div>
    </section>
  );
}
