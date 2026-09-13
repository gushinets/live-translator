import { useEffect, useReducer, useRef, useState } from "react";
import { BootstrapPrompt } from "../components/BootstrapPrompt";
import { PrivacyDisclosure } from "../components/PrivacyDisclosure";
import { ContextTooLongError } from "../live/LiveEvents";
import {
  createDefaultSessionController,
  type SessionController,
} from "../session/SessionController";
import type { SessionState } from "../session/SessionState";

/**
 * Owner start-flow surface used by ContextScreen. SessionController implements
 * this; tests inject a fake so UI behavior can be asserted without Live/audio.
 */
export interface ContextScreenController {
  readonly session: { state: SessionState };
  readonly contextText: string;
  readonly bootstrapText: string;
  readonly ownerError?: string;
  readonly isConnectInFlight?: boolean;
  readonly isInterpreterStarting?: boolean;
  readonly audioElement?: HTMLAudioElement;
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
  const isOwnerSetup =
    sessionState === "idle" ||
    sessionState === "connecting" ||
    sessionState === "context" ||
    sessionState === "bootstrap" ||
    sessionState === "error";
  const isBusy =
    sessionState === "connecting" ||
    sessionState === "error" ||
    controller.isConnectInFlight === true;

  return (
    <section>
      <div ref={audioHostRef} hidden />
      {!isOwnerSetup ? (
        <>
          <p>Interpreter active</p>
          <button
            type="button"
            onClick={() => {
              void controller.cancel();
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
      {controller.ownerError !== undefined ? (
        <p role="alert">{controller.ownerError}</p>
      ) : null}
      {isBootstrap ? (
        <BootstrapPrompt
          transcript={controller.bootstrapText}
          actionsDisabled={controller.isInterpreterStarting === true}
          onMicrophone={() => undefined}
          onSkip={() => {
            void handleSkip();
          }}
          onAccept={() => {
            void handleAccept();
          }}
        />
      ) : (
        <button
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
          Tell me the context (optional)
        </button>
      )}
      <label>
        Context
        <textarea
          aria-label="Context"
          value={controller.contextText}
          onChange={(event) => {
            controller.setContextText(event.target.value);
          }}
        />
      </label>
      <button type="button" onClick={() => controller.clearContext()}>
        Clear
      </button>
      {isBootstrap ? null : (
        <button
          type="button"
          disabled={isBusy}
          onClick={() => {
            void handleStart();
          }}
        >
          Start translation
        </button>
      )}
      <PrivacyDisclosure />
      {controller.session.state === "idle" && controller.ownerError === undefined ? null : (
        <button
          type="button"
          onClick={() => {
            void controller.cancel();
          }}
        >
          Cancel
        </button>
      )}
        </>
      )}
    </section>
  );
}
