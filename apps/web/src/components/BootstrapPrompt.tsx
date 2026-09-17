/**
 * Owner-only Participant B language prompt. Binding spec 1.2.1 §3.3 / §4.3.
 * The question is UI text, never spoken by GPT-Live. There is no language picker.
 */
export function BootstrapPrompt({
  transcript,
  onSkip,
  onAccept,
  actionsDisabled = false,
}: {
  transcript: string;
  onSkip: () => void;
  onAccept: () => void;
  actionsDisabled?: boolean;
}) {
  const hint = transcript.trim();

  return (
    <section className="bootstrap-prompt" aria-labelledby="bootstrap-title">
      <div className="bootstrap-status" role="status" aria-live="polite">
        <span className="bootstrap-status-dot" aria-hidden="true" />
        {actionsDisabled ? "Запускаю перевод…" : "Слушаю язык"}
      </div>

      <div className="bootstrap-copy">
        <h2 id="bootstrap-title" className="bootstrap-title">
          На каком языке говорит собеседник?
        </h2>
        <p className="bootstrap-description">
          Назовите язык вслух или пропустите этот шаг.
        </p>
      </div>

      {transcript.length > 0 ? (
        <div className="bootstrap-hint" aria-live="polite">
          <p className="bootstrap-hint-label">Распознано</p>
          <p className="bootstrap-hint-value">{transcript}</p>
        </div>
      ) : (
        <div className="bootstrap-waiting" aria-hidden="true">
          Жду название языка…
        </div>
      )}

      <div className="bootstrap-actions">
        {hint.length > 0 ? (
          <button
            className="setup-primary-action"
            type="button"
            disabled={actionsDisabled}
            onClick={onAccept}
          >
            Продолжить
          </button>
        ) : null}
        <button
          className="setup-secondary-action"
          type="button"
          disabled={actionsDisabled}
          onClick={onSkip}
        >
          Пропустить
        </button>
      </div>
    </section>
  );
}
