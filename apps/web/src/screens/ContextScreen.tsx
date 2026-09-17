import { useEffect, useReducer, useRef, useState } from "react";
import { ErrorOverlay } from "../components/ErrorOverlay";
import { BootstrapPrompt } from "../components/BootstrapPrompt";
import { ContextTooLongError } from "../live/LiveEvents";
import {
  createDefaultSessionController,
  type LifecycleSuspendReason,
  type RecoveryPrompt,
  type SessionController,
} from "../session/SessionController";
import type { TranslationSession } from "../session/SessionState";
import type { Side } from "../conversation/Turn";
import {
  traceBootstrapAction,
  traceConversationRenderPredicate,
} from "../live/StartupTrace";
import { ConversationScreen } from "./ConversationScreen";
import "./ContextScreen.css";

/**
 * Owner start-flow surface used by ContextScreen. SessionController implements
 * this; tests inject a fake so UI behavior can be asserted without Live/audio.
 */
export interface ContextScreenController {
  readonly session: TranslationSession;
  readonly inputReady: boolean;
  readonly contextText: string;
  readonly bootstrapText: string;
  readonly ownerError?: string;
  readonly hasEnteredInterpreter?: boolean;
  readonly isConnectInFlight?: boolean;
  readonly isInterpreterStarting?: boolean;
  readonly audioElement?: HTMLAudioElement;
  readonly recoveryPrompt?: RecoveryPrompt;
  readonly suspendReason?: LifecycleSuspendReason;
  subscribe(listener: () => void): () => void;
  startContextCapture(): Promise<void>;
  finishContextCapture(): void;
  setContextText(text: string): void;
  clearContext(): void;
  startBootstrap(): Promise<void>;
  skipBootstrap(): void;
  acceptBootstrap(text: string): void;
  beginInterpreter(): Promise<void>;
  cancel(): Promise<void>;
  correctLastTurn(side: Side): Promise<void>;
  endConversation(): Promise<void>;
  resumeFromSourceTimeout(): Promise<void>;
}

export function ContextScreen({
  controller: injectedController,
}: {
  controller?: ContextScreenController;
} = {}) {
  const [ownedController] = useState<SessionController | null>(() =>
    injectedController === undefined ? createDefaultSessionController() : null,
  );
  const resolvedController = injectedController ?? ownedController;
  if (resolvedController === null) {
    throw new Error("ContextScreen controller is missing");
  }
  const controller: ContextScreenController = resolvedController;

  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const audioHostRef = useRef<HTMLDivElement>(null);
  useEffect(() => controller.subscribe(rerender), [controller]);
  useEffect(() => {
    const host = audioHostRef.current;
    const element = controller.audioElement;
    if (host === null || element === undefined) {
      return;
    }
    host.appendChild(element);
    return () => {
      if (element.parentNode === host) {
        host.removeChild(element);
      }
    };
  }, [controller.audioElement]);

  async function handleStart(): Promise<void> {
    if (controller.session.state === "context") {
      controller.finishContextCapture();
    }
    try {
      await controller.startBootstrap();
    } catch (error) {
      console.error("Failed to enter language bootstrap", {
        error,
        state: controller.session.state,
      });
    }
  }

  async function handleSkip(): Promise<void> {
    if (controller.isInterpreterStarting === true) {
      return;
    }
    traceBootstrapAction("skip", {
      state: controller.session.state,
      isInterpreterStarting: false,
      enteredInterpreter: controller.hasEnteredInterpreter === true,
    });
    controller.skipBootstrap();
    try {
      await controller.beginInterpreter();
    } catch (error) {
      if (error instanceof ContextTooLongError) {
        return;
      }
      console.error("Failed to begin interpreter after bootstrap skip", {
        error,
        state: controller.session.state,
      });
    }
  }

  async function handleAccept(): Promise<void> {
    if (controller.isInterpreterStarting === true) {
      return;
    }
    traceBootstrapAction("accept", {
      state: controller.session.state,
      isInterpreterStarting: false,
      enteredInterpreter: controller.hasEnteredInterpreter === true,
    });
    const hint = controller.bootstrapText.trim();
    controller.acceptBootstrap(hint);
    try {
      await controller.beginInterpreter();
    } catch (error) {
      if (error instanceof ContextTooLongError) {
        return;
      }
      console.error("Failed to begin interpreter after bootstrap accept", {
        error,
        state: controller.session.state,
      });
    }
  }

  const sessionState = controller.session.state;
  const isBootstrap = sessionState === "bootstrap";
  const isConversation =
    sessionState === "listening" ||
    sessionState === "outputting" ||
    sessionState === "correcting" ||
    sessionState === "suspended" ||
    sessionState === "ending" ||
    (sessionState === "error" && controller.hasEnteredInterpreter === true);
  const isOwnerSetup = !isConversation;
  const isBusy =
    sessionState === "connecting" ||
    sessionState === "error" ||
    controller.isConnectInFlight === true;
  const isContextListening = sessionState === "context";
  const showCancel =
    controller.session.state !== "idle" ||
    controller.ownerError !== undefined ||
    controller.isConnectInFlight === true;

  traceConversationRenderPredicate({
    state: sessionState,
    isConversation,
    isOwnerSetup,
    enteredInterpreter: controller.hasEnteredInterpreter === true,
    isInterpreterStarting: controller.isInterpreterStarting === true,
  });

  return (
    <section
      className={isOwnerSetup ? "setup-screen" : undefined}
      aria-label={isOwnerSetup ? "Настройка переводчика" : undefined}
    >
      <div ref={audioHostRef} hidden />
      {!isOwnerSetup ? (
        <ConversationScreen controller={controller} />
      ) : (
        <div className="setup-shell">
          <header className="setup-header">
            <h1>Переводчик</h1>
          </header>

          <div className="setup-card">
            {controller.ownerError !== undefined ? (
              <ErrorOverlay message={controller.ownerError} />
            ) : null}

            {isBootstrap ? (
              <BootstrapPrompt
                transcript={controller.bootstrapText}
                actionsDisabled={controller.isInterpreterStarting === true}
                onSkip={() => {
                  void handleSkip();
                }}
                onAccept={() => {
                  void handleAccept();
                }}
              />
            ) : (
              <>
                <button
                  className="setup-secondary-action setup-context-action"
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    void controller.startContextCapture().catch((error: unknown) => {
                      console.error("Failed to start context capture", {
                        error,
                        state: controller.session.state,
                      });
                    });
                  }}
                >
                  Продиктовать контекст
                </button>

                {isContextListening ? (
                  <p className="setup-inline-status" role="status">
                    <span className="setup-status-dot" aria-hidden="true" />
                    Слушаю контекст
                  </p>
                ) : null}

                <label className="setup-field">
                  <span className="setup-field-label">
                    Контекст <span>необязательно</span>
                  </span>
                  <textarea
                    aria-label="Контекст"
                    className="resize-none"
                    value={controller.contextText}
                    placeholder="Например: заселение в отель или доставка"
                    onChange={(event) => {
                      controller.setContextText(event.target.value);
                    }}
                  />
                </label>

                <div className="setup-field-footer">
                  <span>Коротко опишите ситуацию</span>
                  <button
                    className="setup-text-action"
                    type="button"
                    onClick={() => controller.clearContext()}
                  >
                    Очистить
                  </button>
                </div>

                <button
                  className="setup-primary-action"
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    void handleStart();
                  }}
                >
                  Начать перевод
                </button>
              </>
            )}
          </div>

          <footer className="setup-footer">
            {showCancel ? (
              <button
                className="setup-cancel-action"
                type="button"
                onClick={() => {
                  void controller.cancel();
                }}
              >
                Отмена
              </button>
            ) : null}
          </footer>
        </div>
      )}
    </section>
  );
}
