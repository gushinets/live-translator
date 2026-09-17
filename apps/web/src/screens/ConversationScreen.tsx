import { useEffect, useReducer } from "react";
import { ErrorOverlay } from "../components/ErrorOverlay";
import "./ConversationScreen.css";
import { ParticipantPane } from "../components/ParticipantPane";
import { deriveParticipantStatus } from "../components/ParticipantStatus";
import { MAX_RECENT_TURNS } from "../conversation/TurnBuffer";
import type { Side } from "../conversation/Turn";
import type { LifecycleSuspendReason, RecoveryPrompt } from "../session/SessionController";
import type { TranslationSession } from "../session/SessionState";

export interface ConversationScreenController {
  readonly session: TranslationSession;
  readonly inputReady: boolean;
  readonly recoveryPrompt?: RecoveryPrompt;
  readonly ownerError?: string;
  readonly suspendReason?: LifecycleSuspendReason;
  subscribe(listener: () => void): () => void;
  correctLastTurn(side: Side): Promise<void>;
  endConversation(): Promise<void>;
  resumeFromSourceTimeout(): Promise<void>;
}

export function ConversationScreen({
  controller,
}: {
  controller: ConversationScreenController;
}) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => controller.subscribe(rerender), [controller]);

  const session = controller.session;
  const active = session.activeTurn;
  const sourceSpeaker = active?.speaker;
  const sourceActive = active !== undefined && active.sourceIdleAtMs === undefined;
  const originalText = active?.originalText ?? "";
  const translatedText = active?.translatedText ?? "";
  const hasOutputText = (active?.translatedText ?? "").length > 0;
  const audioOutputStarted = active?.audioOutputStarted === true;
  const recentTurns = session.recentTurns.slice(-MAX_RECENT_TURNS);
  const terminalAlert =
    session.state === "error" || session.state === "ending"
      ? controller.ownerError
      : undefined;
  const statusA = deriveParticipantStatus({
    sessionState: session.state,
    expectedSpeaker: session.expectedSpeaker,
    inputReady: controller.inputReady,
    side: "A",
    sourceSpeaker,
    sourceActive,
    hasOutputText,
    audioOutputStarted,
  });
  const statusB = deriveParticipantStatus({
    sessionState: session.state,
    expectedSpeaker: session.expectedSpeaker,
    inputReady: controller.inputReady,
    side: "B",
    sourceSpeaker,
    sourceActive,
    hasOutputText,
    audioOutputStarted,
  });

  return (
    <section className="conversation-screen">
      {controller.suspendReason === "orientation" ? (
        <div
          className="rotate-overlay"
          data-testid="rotate-overlay"
          role="dialog"
          aria-modal="true"
          style={{ transform: "none" }}
        >
          <p>Поверните телефон вертикально</p>
        </div>
      ) : null}
      <ParticipantPane
        side="B"
        rotated
        status={statusB}
        isSourceSide={sourceSpeaker === "B"}
        originalText={originalText}
        translatedText={translatedText}
        recentTurns={recentTurns}
        alertText={terminalAlert}
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
        <button
          type="button"
          onClick={() => {
            void controller.endConversation().catch((error: unknown) => {
              console.error("End conversation failed", {
                error,
                state: session.state,
              });
            });
          }}
        >
          Завершить
        </button>
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
            Продолжить / повторить
          </button>
        ) : null}
        {controller.recoveryPrompt === "repeat" ? <p>Повторите</p> : null}
        {terminalAlert === undefined && controller.ownerError !== undefined ? (
          <ErrorOverlay message={controller.ownerError} />
        ) : null}
      </div>
      <ParticipantPane
        side="A"
        rotated={false}
        status={statusA}
        isSourceSide={sourceSpeaker === "A"}
        originalText={originalText}
        translatedText={translatedText}
        recentTurns={recentTurns}
        alertText={terminalAlert}
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
