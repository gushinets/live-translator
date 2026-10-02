import { createAccountedSessionController, type AccountedSessionController } from "../session/createAccountedSessionController";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ErrorOverlay } from "../components/ErrorOverlay";
import { BootstrapPrompt } from "../components/BootstrapPrompt";
import { LanguagePicker } from "../components/LanguagePicker";
import { RetainedRecovery, type RetainedRecoveryState } from "../components/RetainedRecovery";
import { ContextTooLongError } from "../live/LiveEvents";
import {
  type LifecycleSuspendReason,
  type RecoveryPrompt,
  type SessionController,
} from "../session/SessionController";
import type { TranslationSession } from "../session/SessionState";
import type { Side } from "../conversation/Turn";
import { preferredLanguage, supportedLanguageCodes } from "../side/SideResolver";
import {
  traceBootstrapAction,
  traceConversationRenderPredicate,
} from "../live/StartupTrace";
import { ConversationScreen } from "./ConversationScreen";
import "./ContextScreen.css";
import { translate, uiLocale } from "../i18n/messages";

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
  readonly selectedInterlocutorLanguage?: string;
  subscribe(listener: () => void): () => void;
  startContextCapture(): Promise<void>;
  finishContextCapture(): void;
  setContextText(text: string): void;
  clearContext(): void;
  startBootstrap(): Promise<void>;
  startWithLanguages(languages: { A: string; B: string }): Promise<void>;
  changeInterlocutorLanguage(language: string): Promise<void>;
  readonly bootstrapSide: Side;
  readonly bootstrapRecording: boolean;
  acceptBootstrap(text: string): Promise<void>;
  beginInterpreter(): Promise<void>;
  cancel(): Promise<void>;
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
    controller.audioElement, controller.selectedInterlocutorLanguage];
}

let documentController: AccountedSessionController | null = null;
let documentOwners = 0;
let disposalToken = 0;
let pendingDisposal: Promise<void> | null = null;
let documentDisposalFailed = false;

const INTERLOCUTOR_LANGUAGE_KEY = "live-translator-interlocutor-language";
const OWNER_LANGUAGE_KEY = "live-translator-owner-language";

function savedInterlocutorLanguage(): string | undefined {
  try {
    const code = localStorage.getItem(INTERLOCUTOR_LANGUAGE_KEY);
    return code && supportedLanguageCodes().includes(code) ? code : undefined;
  } catch { return undefined; }
}

function devicePreferredLanguage(): string | undefined {
  const browserLocales = navigator.languages?.length ? navigator.languages : [navigator.language];
  return preferredLanguage([Intl.DateTimeFormat().resolvedOptions().locale, ...browserLocales]);
}

function initialOwnerLanguage(): string | undefined {
  try {
    const saved = localStorage.getItem(OWNER_LANGUAGE_KEY);
    if (saved && supportedLanguageCodes().includes(saved)) return saved;
  } catch { /* Browser preference remains available without storage. */ }
  return devicePreferredLanguage();
}

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
  const [ownerLanguage, setOwnerLanguage] = useState(initialOwnerLanguage);
  const [draftOwnerLanguage, setDraftOwnerLanguage] = useState<string>();
  const [interlocutorLanguage, setInterlocutorLanguage] = useState(savedInterlocutorLanguage);
  const [pickerMode, setPickerMode] = useState<"start" | "change" | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [languageChangeError, setLanguageChangeError] = useState<string>();
  const [startingWithLanguages, setStartingWithLanguages] = useState(false);
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
  const invalidLanguagePair = !ownerLanguage || !interlocutorLanguage || ownerLanguage === interlocutorLanguage;
  const showStartPicker = !startingWithLanguages && controller?.session.state === "idle" && (pickerMode === "start" || invalidLanguagePair);
  const ownerLocale = uiLocale(showStartPicker && controller?.retainedRecoveryState === undefined
    ? draftOwnerLanguage || ownerLanguage : controller?.session.participantA.language ?? ownerLanguage);
  const t = (text: string) => translate(text, ownerLocale);

  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const audioHostRef = useRef<HTMLDivElement>(null);
  const languageDialogRef = useRef<HTMLDialogElement>(null);
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
  useEffect(() => {
    if (pickerMode !== "change") return;
    const dialog = languageDialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [pickerMode]);
  useEffect(() => {
    if (pickerMode === "change" && controller?.session.state === "idle") setPickerMode(null);
  }, [controller?.session.state, pickerMode]);

  if (ownerFailed) return <main className="setup-screen" lang={ownerLocale} role="alert">
    <div className="setup-shell">
      <header className="setup-header"><p className="setup-brand">Live Translator</p></header>
      <div className="setup-card">{t("Не удалось завершить предыдущий разговор.")}</div>
    </div>
  </main>;
  if (controller === null) return <main className="setup-screen" lang={ownerLocale} aria-busy="true">
    <div className="setup-shell">
      <header className="setup-header"><p className="setup-brand">Live Translator</p></header>
      <div className="setup-card">{t("Подготовка сеанса…")}</div>
    </div>
  </main>;
  const activeController = controller;

  async function handleRecord(): Promise<void> {
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

  async function handleStart(): Promise<void> {
    if (!ownerLanguage || !interlocutorLanguage || ownerLanguage === interlocutorLanguage) {
      setPickerMode("start");
      return;
    }
    setStartingWithLanguages(true);
    try {
      await activeController.startWithLanguages({ A: ownerLanguage, B: interlocutorLanguage });
    } catch (error) {
      console.error("Failed to start translation", { error });
    } finally {
      setStartingWithLanguages(false);
    }
  }

  async function handleLanguageConfirm(owner: string, interlocutor: string): Promise<void> {
    setPickerBusy(true);
    setLanguageChangeError(undefined);
    setOwnerLanguage(owner);
    setDraftOwnerLanguage(undefined);
    setInterlocutorLanguage(interlocutor);
    try {
      localStorage.setItem(INTERLOCUTOR_LANGUAGE_KEY, interlocutor);
      if (owner !== devicePreferredLanguage()) {
        localStorage.setItem(OWNER_LANGUAGE_KEY, owner);
      } else localStorage.removeItem(OWNER_LANGUAGE_KEY);
    } catch { /* This tab still remembers the choice when storage is unavailable. */ }
    const changing = pickerMode === "change";
    if (!changing) {
      setStartingWithLanguages(true);
      setPickerMode(null);
    }
    try {
      if (changing) await activeController.changeInterlocutorLanguage(interlocutor);
      else await activeController.startWithLanguages({ A: owner, B: interlocutor });
      if (changing) setPickerMode(null);
    } catch (error) {
      if (changing) setLanguageChangeError("Не удалось сменить язык. Дождитесь возобновления разговора и повторите попытку.");
      console.error("Failed to apply language choice", { error });
    } finally {
      setPickerBusy(false);
      if (!changing) setStartingWithLanguages(false);
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
    sessionState === "suspended" ||
    sessionState === "ending" ||
    (sessionState === "error" && controller.hasEnteredInterpreter === true);
  const isOwnerSetup = !isConversation;
  const isBusy =
    sessionState === "error" ||
    controller.isConnectInFlight === true || controller.retainedRecoveryState !== undefined;
  const recovery = controller.retainedRecoveryState;
  const showStartLayout = !showStartPicker && (sessionState === "idle" || startingWithLanguages);
  const showSettings = (sessionState === "idle" || startingWithLanguages) &&
    !invalidLanguagePair && recovery === undefined;
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
      lang={ownerLocale}
      aria-label={isOwnerSetup ? t("Настройка переводчика") : undefined}
    >
      <div ref={audioHostRef} hidden />
      {!isOwnerSetup ? (
        <>
          <ConversationScreen controller={controller} onChangeLanguage={() => {
            setLanguageChangeError(undefined);
            setPickerMode("change");
          }} />
          {pickerMode === "change" ? <dialog ref={languageDialogRef} className="language-picker-overlay"
            aria-label={t("Сменить язык собеседника")} onCancel={event => {
              event.preventDefault();
              setPickerMode(null);
            }}>
            <div className="language-picker-overlay-content">
              <header className="setup-header"><p className="setup-brand">Live Translator</p></header>
              <LanguagePicker ownerLanguage={controller.session.participantA.language}
                interlocutorLanguage={controller.selectedInterlocutorLanguage ?? controller.session.participantB.language}
                allowOwnerChange={false}
                busy={pickerBusy}
                onConfirm={(owner, interlocutor) => { void handleLanguageConfirm(owner, interlocutor); }}
                onCancel={() => setPickerMode(null)} />
              {languageChangeError ? <p role="alert">{t(languageChangeError)}</p> : null}
            </div>
          </dialog> : null}
        </>
      ) : (
        <div className={`setup-shell${showStartPicker ? " setup-shell--picker" : ""}${showStartLayout ? " setup-shell--start" : ""}`}>
          <header className="setup-header">
            <p className="setup-brand">Live Translator</p>
            {showSettings ? <button className="setup-settings-action" type="button"
              aria-label={t(showStartPicker ? "Закрыть настройки" : "Настройки")}
              aria-expanded={showStartPicker}
              disabled={startingWithLanguages}
              onClick={() => {
                setDraftOwnerLanguage(undefined);
                setPickerMode(showStartPicker ? null : "start");
              }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.4 2.8h3.2l.5 2.1c.5.2 1 .4 1.5.7l1.9-1.1 2.3 2.3-1.1 1.9c.3.5.5 1 .7 1.5l2.1.5v3.2l-2.1.5c-.2.5-.4 1-.7 1.5l1.1 1.9-2.3 2.3-1.9-1.1c-.5.3-1 .5-1.5.7l-.5 2.1h-3.2l-.5-2.1c-.5-.2-1-.4-1.5-.7l-1.9 1.1-2.3-2.3 1.1-1.9c-.3-.5-.5-1-.7-1.5l-2.1-.5v-3.2l2.1-.5c.2-.5.4-1 .7-1.5L4.2 6.8l2.3-2.3 1.9 1.1c.5-.3 1-.5 1.5-.7z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button> : null}
          </header>

          <div className={`setup-card${showStartPicker ? " setup-card--picker" : ""}${showStartLayout ? " setup-card--start" : ""}`}>
            {recovery === undefined && controller.ownerError !== undefined ? (
              <ErrorOverlay message={controller.ownerError} language={ownerLocale} />
            ) : null}
            {recovery !== undefined ? (
              <RetainedRecovery state={recovery} surface="setup" language={ownerLocale}
                onResume={controller.resumeRetainedConversation?.bind(controller)}
                onVerify={controller.verifyRetainedConversation?.bind(controller)}
                onEnd={() => controller.endConversation()} />
            ) : isBootstrap && controller.isConnectInFlight && !startingWithLanguages ? (
              <p role="status" className="setup-inline-status">{t("Запускаю перевод…")}</p>
            ) : isBootstrap && !startingWithLanguages ? (
              <BootstrapPrompt
                transcript={controller.bootstrapText}
                side={controller.bootstrapSide}
                recording={controller.bootstrapRecording}
                languageA={controller.session.participantA.language}
                languageB={controller.session.participantB.language}
                language={ownerLocale}
                actionsDisabled={controller.isInterpreterStarting === true || isBusy}
                primaryActionRef={bootstrapPrimaryRef}
                repeatActionRef={bootstrapRepeatRef}
                onRecord={() => { void handleRecord(); }}
                onBegin={() => { void handleBegin(); }}
                onAccept={() => {
                  void handleAccept();
                }}
              />
            ) : showStartPicker ? (
              <LanguagePicker ownerLanguage={ownerLanguage} interlocutorLanguage={interlocutorLanguage}
                onOwnerChange={setDraftOwnerLanguage}
                busy={pickerBusy || isBusy} startAction primaryActionRef={startRef}
                onConfirm={(owner, interlocutor) => { void handleLanguageConfirm(owner, interlocutor); }} />
            ) : (
              <>
                <button
                  ref={startRef}
                  className={`setup-primary-action${startingWithLanguages ? " setup-primary-action--connecting" : ""}`}
                  type="button"
                  disabled={isBusy || startingWithLanguages}
                  onClick={() => {
                    void handleStart();
                  }}
                >
                  {startingWithLanguages ? <span className="setup-connecting-label" aria-live="polite">{t("Устанавливаю связь…")}</span> : t("Начать перевод")}
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
                {t("Отмена")}
              </button>
            ) : null}
          </footer>
        </div>
      )}
    </section>
  );
}
