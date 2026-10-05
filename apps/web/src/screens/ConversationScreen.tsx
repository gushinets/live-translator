import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { ErrorOverlay } from "../components/ErrorOverlay";
import { RetainedRecovery, type RetainedRecoveryState } from "../components/RetainedRecovery";
import "./ConversationScreen.css";
import { ParticipantPane } from "../components/ParticipantPane";
import { deriveParticipantStatus } from "../components/ParticipantStatus";
import type { LifecycleSuspendReason, RecoveryPrompt } from "../session/SessionController";
import type { TranslationSession } from "../session/SessionState";
import { translate, uiLocale } from "../i18n/messages";
import type { Side, Turn } from "../conversation/Turn";
import type { DialogueBlock } from "../conversation/DialogueTranscript";

export interface ConversationScreenController {
  readonly session: TranslationSession;
  readonly captionBlocks: readonly DialogueBlock[];
  readonly inputReady: boolean;
  readonly recoveryPrompt?: RecoveryPrompt;
  readonly recoveryPromptIsTurnFailure?: boolean;
  readonly ownerError?: string;
  readonly suspendReason?: LifecycleSuspendReason;
  readonly retainedRecoveryState?: RetainedRecoveryState;
  subscribe(listener: () => void): () => void;
  endConversation(): Promise<void>;
  resumeFromSourceTimeout(): Promise<void>;
  resumeRetainedConversation?(): Promise<void>;
  verifyRetainedConversation?(): Promise<void>;
}

function uiSnapshot(controller: ConversationScreenController): unknown[] {
  return [controller.session, controller.inputReady, controller.recoveryPrompt, controller.ownerError,
    controller.suspendReason, controller.retainedRecoveryState, controller.captionBlocks, controller.recoveryPromptIsTurnFailure];
}

export function ConversationScreen({
  controller,
  onChangeLanguage,
}: {
  controller: ConversationScreenController;
  onChangeLanguage?: () => void;
}) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const endRef = useRef<HTMLButtonElement>(null);
  const renderedSnapshot = useRef<unknown[]>([]);
  const snapshot = uiSnapshot(controller);
  useLayoutEffect(() => { renderedSnapshot.current = snapshot; });
  const previousRecovery = useRef<RetainedRecoveryState | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = controller.subscribe(rerender);
    if (uiSnapshot(controller).some((value, index) => !Object.is(value, renderedSnapshot.current[index]))) rerender();
    return unsubscribe;
  }, [controller]);
  useEffect(() => {
    if (previousRecovery.current !== undefined && controller.retainedRecoveryState === undefined) endRef.current?.focus();
    previousRecovery.current = controller.retainedRecoveryState;
  }, [controller.retainedRecoveryState]);

  const session = controller.session;
  const captions = controller.captionBlocks;
  const ownerLocale = uiLocale(session.participantA.language);
  const t = (text: string) => translate(text, ownerLocale);
  const ending = session.state === "ending";
  const recoveryState = controller.retainedRecoveryState;
  const active = session.activeTurn;
  const sourceSpeaker = active?.speaker;
  const sourceActive = active !== undefined && active.sourceIdleAtMs === undefined;
  const isPlaying = (turn: Turn) => turn.audioOutputStarted && !turn.audioOutputInterrupted && turn.playbackEndAtMs === undefined;
  const hasTextActivity = (turn: Turn) => (turn.translatedText ?? "").length > 0 &&
    (turn.playbackEndAtMs === undefined ? !turn.audioOutputInterrupted : (turn.outputTextEndAtMs ?? -Infinity) > turn.playbackEndAtMs);
  const outputs = [...(session.pendingTurns ?? []), ...(active ? [active] : [])].filter(turn =>
    (turn.status === "streaming" || turn.status === "outputting") && turn.speaker !== undefined &&
    (hasTextActivity(turn) || isPlaying(turn)));
  const statusForSide = (side: Side) => {
    const output = outputs.find(turn => turn.speaker !== side && isPlaying(turn))
      ?? outputs.find(turn => turn.speaker !== side) ?? outputs[0];
    return deriveParticipantStatus({
      sessionState: session.state, inputReady: controller.inputReady, side, sourceSpeaker, sourceActive,
      outputSpeaker: output?.speaker,
      hasOutputText: (output?.translatedText ?? "").length > 0,
      audioOutputStarted: output !== undefined && isPlaying(output),
    });
  };
  const terminalAlert =
    session.state === "error" || session.state === "ending"
      ? controller.ownerError === undefined ? undefined : t(controller.ownerError)
      : undefined;
  const statusA = statusForSide("A");
  const statusB = statusForSide("B");

  return (
    <section className="conversation-screen" lang={ownerLocale}>
      {controller.suspendReason === "orientation" ? (
        <div
          className="rotate-overlay"
          data-testid="rotate-overlay"
          role="dialog"
          aria-modal="true"
          style={{ transform: "none" }}
        >
          <p>{t("Поверните телефон вертикально")}</p>
        </div>
      ) : null}
      <ParticipantPane
        side="B"
        language={session.participantB.language}
        rotated
        status={statusB}
        captions={captions.filter(block => block.side === "B")}
        alertText={terminalAlert}
        alertLanguage={ownerLocale}
      />
      <div className="conversation-center">
        {onChangeLanguage ? <button className="conversation-language-action" type="button"
          disabled={session.state !== "listening" && session.state !== "outputting"}
          onClick={onChangeLanguage}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16m-5-5 5 5-5 5M20 17H4m5-5-5 5 5 5" />
          </svg>
          <span>{t("Язык собеседника")}</span>
        </button> : null}
        {recoveryState !== undefined ? <RetainedRecovery
          state={recoveryState} surface="conversation" language={ownerLocale}
          onResume={controller.resumeRetainedConversation?.bind(controller)}
          onVerify={controller.verifyRetainedConversation?.bind(controller)}
          onEnd={() => controller.endConversation()} /> : null}
        {recoveryState === undefined ? <button
          ref={endRef}
          className="conversation-end-action"
          type="button"
          disabled={ending}
          aria-busy={ending}
          onClick={() => {
            void controller.endConversation().catch((error: unknown) => {
              console.error("End conversation failed", {
                error,
                state: session.state,
              });
            });
          }}
        >
          <span aria-hidden="true" className="conversation-end-size">{t("Завершаю…")}</span>
          <span aria-live="polite" className="conversation-end-label"><i aria-hidden="true" />{t(ending ? "Завершаю…" : "Завершить")}</span>
        </button> : null}
        {controller.recoveryPrompt === "resume-repeat" ? (
          <button
            type="button"
            onClick={() => {
              void controller.resumeFromSourceTimeout().catch((error: unknown) => {
                console.error("Resume from source timeout failed", {
                  error,
                  state: session.state,
                });
              });
            }}
          >
            {t("Продолжить / повторить")}
          </button>
        ) : null}
        {controller.recoveryPrompt === "repeat" && !controller.recoveryPromptIsTurnFailure ? <p>{t("Повторите")}</p> : null}
        {controller.retainedRecoveryState === undefined && terminalAlert === undefined && controller.ownerError !== undefined ? (
          <ErrorOverlay message={controller.ownerError} language={ownerLocale} />
        ) : null}
      </div>
      <ParticipantPane
        side="A"
        language={session.participantA.language}
        rotated={false}
        status={statusA}
        captions={captions.filter(block => block.side === "A")}
        alertText={terminalAlert}
        alertLanguage={ownerLocale}
      />
    </section>
  );
}
