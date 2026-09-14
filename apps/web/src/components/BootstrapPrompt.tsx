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
    <section>
      <p>What language does the other person most likely speak?</p>
      <p>Listening automatically. Ask them to say the language.</p>
      {transcript.length > 0 ? (
        <div aria-live="polite">
          <p>Recognized language hint</p>
          <p>{transcript}</p>
        </div>
      ) : null}
      {hint.length > 0 ? (
        <button type="button" disabled={actionsDisabled} onClick={onAccept}>
          Accept
        </button>
      ) : null}
      <button type="button" disabled={actionsDisabled} onClick={onSkip}>
        Skip
      </button>
    </section>
  );
}
