/**
 * Owner-only Participant B language prompt. Binding spec 1.2.1 §3.3 / §4.3.
 * The question is UI text, never spoken by GPT-Live. There is no language picker.
 */
export function BootstrapPrompt({
  transcript,
  onMicrophone,
  onSkip,
}: {
  transcript: string;
  onMicrophone: () => void;
  onSkip: () => void;
}) {
  return (
    <section>
      <p>What language does the other person most likely speak?</p>
      <button type="button" onClick={onMicrophone} aria-label="microphone">
        Say the language
      </button>
      {transcript.length > 0 ? <p>{transcript}</p> : null}
      <button type="button" onClick={onSkip}>
        Skip
      </button>
    </section>
  );
}
