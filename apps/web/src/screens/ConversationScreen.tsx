import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { ErrorOverlay } from "../components/ErrorOverlay";
import { RetainedRecovery, type RetainedRecoveryState } from "../components/RetainedRecovery";
import "./ConversationScreen.css";
import { ParticipantPane } from "../components/ParticipantPane";
import { deriveParticipantStatus } from "../components/ParticipantStatus";
import { MAX_RECENT_TURNS } from "../conversation/TurnBuffer";
import type { Side } from "../conversation/Turn";
import type { LifecycleSuspendReason, RecoveryPrompt } from "../session/SessionController";
import type { TranslationSession } from "../session/SessionState";
import { translate, uiLocale } from "../i18n/messages";

export interface ConversationScreenController {
  readonly session: TranslationSession;
  readonly inputReady: boolean;
  readonly recoveryPrompt?: RecoveryPrompt;
  readonly ownerError?: string;
  readonly suspendReason?: LifecycleSuspendReason;
  readonly retainedRecoveryState?: RetainedRecoveryState;
  subscribe(listener: () => void): () => void;
  correctLastTurn(side: Side): Promise<void>;
  endConversation(): Promise<void>;
  resumeFromSourceTimeout(): Promise<void>;
  resumeRetainedConversation?(): Promise<void>;
  verifyRetainedConversation?(): Promise<void>;
}

function uiSnapshot(controller: ConversationScreenController): unknown[] {
  return [controller.session, controller.inputReady, controller.recoveryPrompt, controller.ownerError,
    controller.suspendReason, controller.retainedRecoveryState];
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
  const ownerLocale = uiLocale(session.participantA.language);
  const t = (text: string) => translate(text, ownerLocale);
  const ending = session.state === "ending";
  const recoveryState = controller.retainedRecoveryState;
  const active = session.activeTurn;
  const sourceSpeaker = active?.speaker;
  const sourceActive = active !== undefined && active.sourceIdleAtMs === undefined;
  const hasOutputText = (active?.translatedText ?? "").length > 0;
  const audioOutputStarted = active?.audioOutputStarted === true;
  const recentTurns = session.recentTurns.slice(-MAX_RECENT_TURNS);
  const unassigned = active ?? recentTurns.at(-1);
  const canChooseSide = (session.state === "listening" || session.state === "outputting") &&
    unassigned?.speaker === undefined && (unassigned?.originalText.trim().length ?? 0) > 0 &&
    (unassigned?.languages === undefined || (unassigned.languages.A === session.participantA.language &&
      unassigned.languages.B === session.participantB.language)) &&
    unassigned?.status !== "discarded";
  const terminalAlert =
    session.state === "error" || session.state === "ending"
      ? controller.ownerError === undefined ? undefined : t(controller.ownerError)
      : undefined;
  const statusA = deriveParticipantStatus({
    sessionState: session.state,
    inputReady: controller.inputReady,
    side: "A",
    sourceSpeaker,
    sourceActive,
    hasOutputText,
    audioOutputStarted,
  });
  const statusB = deriveParticipantStatus({
    sessionState: session.state,
    inputReady: controller.inputReady,
    side: "B",
    sourceSpeaker,
    sourceActive,
    hasOutputText,
    audioOutputStarted,
  });

  return (
    <section className="conversation-screen" lang={ownerLocale}>
      {onChangeLanguage ? <button className="conversation-language-action" type="button"
        disabled={session.state !== "listening" && session.state !== "outputting"}
        onClick={onChangeLanguage}>
        {t("Язык собеседника")}
      </button> : null}
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
        activeTurn={active}
        recentTurns={recentTurns}
        alertText={terminalAlert}
        alertLanguage={ownerLocale}
        onTap={() => {
          void controller.correctLastTurn("B").catch((error: unknown) => {
            console.error("Correction failed", {
              error,
              side: "B",
              state: session.state,
            });
          });
        }}
      />
      <div className="conversation-center">
        {recoveryState !== undefined ? <RetainedRecovery
          state={recoveryState} surface="conversation" language={ownerLocale}
          onResume={controller.resumeRetainedConversation?.bind(controller)}
          onVerify={controller.verifyRetainedConversation?.bind(controller)}
          onEnd={() => controller.endConversation()} /> : null}
        {canChooseSide ? (
          <p role="status">{t("Сторона не определена. Для исправления нажмите свою половину экрана.")}</p>
        ) : null}
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
          <span aria-live="polite">{t(ending ? "Завершаю…" : "Завершить")}</span>
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
        {controller.recoveryPrompt === "repeat" ? <p>{t("Повторите")}</p> : null}
        {controller.retainedRecoveryState === undefined && terminalAlert === undefined && controller.ownerError !== undefined ? (
          <ErrorOverlay message={controller.ownerError} language={ownerLocale} />
        ) : null}
      </div>
      <ParticipantPane
        side="A"
        language={session.participantA.language}
        rotated={false}
        status={statusA}
        activeTurn={active}
        recentTurns={recentTurns}
        alertText={terminalAlert}
        alertLanguage={ownerLocale}
        onTap={() => {
          void controller.correctLastTurn("A").catch((error: unknown) => {
            console.error("Correction failed", {
              error,
              side: "A",
              state: session.state,
            });
          });
        }}
      />
    </section>
  );
}
