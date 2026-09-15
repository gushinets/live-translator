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
        {actionsDisabled ? "Starting translator…" : "Listening for language"}
      </div>

      <div className="bootstrap-copy">
        <p className="setup-kicker">Language check</p>
        <h2 id="bootstrap-title" className="bootstrap-title">
          What language does the other person most likely speak?
        </h2>
        <p className="bootstrap-description">
          Listening automatically. Ask them to say the language.
        </p>
      </div>

      {transcript.length > 0 ? (
        <div className="bootstrap-hint" aria-live="polite">
          <p className="bootstrap-hint-label">Recognized language hint</p>
          <p className="bootstrap-hint-value">{transcript}</p>
        </div>
      ) : (
        <div className="bootstrap-waiting" aria-hidden="true">
          Waiting for a short language hint…
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
            Accept
          </button>
        ) : null}
        <button
          className="setup-secondary-action"
          type="button"
          disabled={actionsDisabled}
          onClick={onSkip}
        >
          Skip
        </button>
      </div>
    </section>
  );
}
