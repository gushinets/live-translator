import { createAccountedSessionController, type AccountedSessionController } from "../session/createAccountedSessionController";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ErrorOverlay } from "../components/ErrorOverlay";
import { BootstrapPrompt } from "../components/BootstrapPrompt";
import { RetainedRecovery, type RetainedRecoveryState } from "../components/RetainedRecovery";
import { ContextTooLongError } from "../live/LiveEvents";
import {
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
  readonly retainedRecoveryState?: RetainedRecoveryState;
  subscribe(listener: () => void): () => void;
  startContextCapture(): Promise<void>;
  finishContextCapture(): void;
  setContextText(text: string): void;
  clearContext(): void;
  startBootstrap(): Promise<void>;
  readonly bootstrapSide: Side;
  readonly bootstrapRecording: boolean;
  acceptBootstrap(text: string): Promise<void>;
  beginInterpreter(): Promise<void>;
  cancel(): Promise<void>;
  correctLastTurn(side: Side): Promise<void>;
  endConversation(): Promise<void>;
  resumeFromSourceTimeout(): Promise<void>;
  resumeRetainedConversation?(): Promise<void>;
  verifyRetainedConversation?(): Promise<void>;
}

function uiSnapshot(controller: ContextScreenController): unknown[] {
  return [controller.session, controller.inputReady, controller.contextText, controller.bootstrapText,
    controller.bootstrapSide, controller.bootstrapRecording, controller.ownerError,
    controller.hasEnteredInterpreter, controller.isConnectInFlight, controller.isInterpreterStarting,
    controller.recoveryPrompt, controller.suspendReason, controller.retainedRecoveryState,
    controller.audioElement];
}

let documentController: AccountedSessionController | null = null;
let documentOwners = 0;
let disposalToken = 0;
let pendingDisposal: Promise<void> | null = null;
let documentDisposalFailed = false;

function acquireDocumentController(): AccountedSessionController {
  disposalToken++;
  documentController ??= createAccountedSessionController();
  documentOwners++;
  documentController.start();
  return documentController;
}

function releaseDocumentController(): void {
  documentOwners--;
  const token = ++disposalToken;
  queueMicrotask(() => {
    if (documentOwners !== 0 || token !== disposalToken) return;
    const controller = documentController;
    documentController = null;
    if (controller) {
      const work = controller.dispose().catch(error => {
        documentDisposalFailed = true;
        console.error("Session disposal incomplete", { error });
      });
      const settled = work.finally(() => {
        if (pendingDisposal === settled) pendingDisposal = null;
      });
      pendingDisposal = settled;
    }
  });
}

export function ContextScreen({
  controller: injectedController,
}: {
  controller?: ContextScreenController;
} = {}) {
  const [ownedController, setOwnedController] = useState<SessionController | null>(null);
  const [ownerFailed, setOwnerFailed] = useState(false);
  useEffect(() => {
    if (injectedController !== undefined) return;
    let mounted = true, acquired = false;
    const attach = () => {
      if (!mounted) return;
      if (documentDisposalFailed) { setOwnerFailed(true); return; }
      setOwnedController(acquireDocumentController());
      acquired = true;
    };
    if (pendingDisposal) void pendingDisposal.then(attach);
    else attach();
    return () => {
      mounted = false;
      if (acquired) releaseDocumentController();
    };
  }, [injectedController]);
  const resolvedController = injectedController ?? ownedController;
  const controller: ContextScreenController | null = resolvedController;

  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const audioHostRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const bootstrapPrimaryRef = useRef<HTMLButtonElement>(null);
  const bootstrapRepeatRef = useRef<HTMLButtonElement>(null);
  const renderedSnapshot = useRef<unknown[]>([]);
  const snapshot = controller ? uiSnapshot(controller) : [];
  useLayoutEffect(() => { renderedSnapshot.current = snapshot; });
  const previousRecovery = useRef<RetainedRecoveryState | undefined>(undefined);
  const recoveryState = controller?.retainedRecoveryState;
  useEffect(() => {
    if (!controller) return;
    const unsubscribe = controller.subscribe(rerender);
    // Catch a recovery probe that settled between render and subscription.
    if (uiSnapshot(controller).some((value, index) => !Object.is(value, renderedSnapshot.current[index]))) rerender();
    return unsubscribe;
  }, [controller]);
  useEffect(() => {
    if (previousRecovery.current !== undefined && recoveryState === undefined) {
      const target = controller?.session.state === "bootstrap"
        ? [bootstrapPrimaryRef.current, bootstrapRepeatRef.current].find(button => button && !button.disabled)
        : startRef.current;
      if (target && !target.disabled) target.focus();
    }
    previousRecovery.current = recoveryState;
  }, [recoveryState]);
  useEffect(() => {
    const host = audioHostRef.current;
    const element = controller?.audioElement;
    if (host === null || element === undefined) {
      return;
    }
    host.appendChild(element);
    return () => {
      if (element.parentNode === host) {
        host.removeChild(element);
      }
    };
  }, [controller?.audioElement]);

  if (ownerFailed) return <main role="alert">Не удалось завершить предыдущий разговор.</main>;
  if (controller === null) return <main aria-busy="true">Подготовка сеанса…</main>;
  const activeController = controller;

  async function handleStart(): Promise<void> {
    if (activeController.session.state === "context") {
      activeController.finishContextCapture();
    }
    try {
      await activeController.startBootstrap();
    } catch (error) {
      console.error("Failed to enter language bootstrap", {
        error,
        state: activeController.session.state,
      });
    }
  }

  async function handleBegin(): Promise<void> {
    if (activeController.isInterpreterStarting === true) return;
    traceBootstrapAction("accept", {
      state: activeController.session.state,
      isInterpreterStarting: false,
      enteredInterpreter: activeController.hasEnteredInterpreter === true,
    });
    try {
      await activeController.beginInterpreter();
    } catch (error) {
      if (!(error instanceof ContextTooLongError)) {
        console.error("Failed to begin interpreter", { error });
      }
    }
  }

  async function handleAccept(): Promise<void> {
    if (activeController.isInterpreterStarting === true) return;
    try {
      await activeController.acceptBootstrap(activeController.bootstrapText.trim());
    } catch (error) {
      console.error("Failed to save language sample", { error });
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
    sessionState === "error" ||
    controller.isConnectInFlight === true || controller.retainedRecoveryState !== undefined;
  const recovery = controller.retainedRecoveryState;
  const isContextListening = sessionState === "context";
  const showCancel =
    recovery === undefined && (controller.session.state !== "idle" ||
    controller.ownerError !== undefined ||
    controller.isConnectInFlight === true);

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
            {recovery === undefined && controller.ownerError !== undefined ? (
              <ErrorOverlay message={controller.ownerError} />
            ) : null}
            {recovery !== undefined ? (
              <RetainedRecovery state={recovery} surface="setup"
                onResume={controller.resumeRetainedConversation?.bind(controller)}
                onVerify={controller.verifyRetainedConversation?.bind(controller)}
                onEnd={() => controller.endConversation()} />
            ) : isBootstrap ? (
              <BootstrapPrompt
                transcript={controller.bootstrapText}
                side={controller.bootstrapSide}
                recording={controller.bootstrapRecording}
                languageA={controller.session.participantA.language}
                languageB={controller.session.participantB.language}
                actionsDisabled={controller.isInterpreterStarting === true || isBusy}
                primaryActionRef={bootstrapPrimaryRef}
                repeatActionRef={bootstrapRepeatRef}
                onRecord={() => { void handleStart(); }}
                onBegin={() => { void handleBegin(); }}
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
                  ref={startRef}
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
