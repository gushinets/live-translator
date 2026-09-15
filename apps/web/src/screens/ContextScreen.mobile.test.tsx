import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Side } from "../conversation/Turn";
import type { LifecycleSuspendReason, RecoveryPrompt } from "../session/SessionController";
import { createInitialSession, type TranslationSession } from "../session/SessionState";
import { ContextScreen, type ContextScreenController } from "./ContextScreen";

afterEach(cleanup);

function idleSession(): TranslationSession {
  return createInitialSession(
    { side: "A", hasAcceptedConversationSpeech: false },
    { side: "B", hasAcceptedConversationSpeech: false },
  );
}

class MobileUiController implements ContextScreenController {
  session: TranslationSession = idleSession();
  inputReady = true;
  contextText = "";
  bootstrapText = "";
  ownerError: string | undefined;
  hasEnteredInterpreter = false;
  isConnectInFlight = false;
  isInterpreterStarting = false;
  audioElement: HTMLAudioElement | undefined;
  recoveryPrompt: RecoveryPrompt | undefined;
  suspendReason: LifecycleSuspendReason | undefined;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startContextCapture(): Promise<void> {}
  finishContextCapture(): void {}
  setContextText(text: string): void {
    this.contextText = text;
  }
  clearContext(): void {
    this.contextText = "";
  }
  async startBootstrap(): Promise<void> {}
  skipBootstrap(): void {}
  acceptBootstrap(_text: string): void {}
  async beginInterpreter(): Promise<void> {}
  async cancel(): Promise<void> {}
  async correctLastTurn(_side: Side): Promise<void> {}
  async endConversation(): Promise<void> {}
  async resumeFromSourceTimeout(): Promise<void> {}
}

describe("ContextScreen mobile setup UI", () => {
  it("renders setup as an accessible mobile app shell with a primary action", () => {
    render(<ContextScreen controller={new MobileUiController()} />);

    const setup = screen.getByRole("region", { name: "Translator setup" });
    expect(setup).toHaveClass("setup-screen");
    expect(setup.querySelector(".setup-shell")).not.toBeNull();
    expect(setup.querySelector(".setup-card")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Start translation" })).toHaveClass(
      "setup-primary-action",
    );
    expect(screen.getByText(/Speech is sent to OpenAI/i)).toHaveClass(
      "privacy-disclosure",
    );
  });

  it("renders bootstrap as a focused listening state", () => {
    const controller = new MobileUiController();
    controller.session = { ...controller.session, state: "bootstrap" };

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("status")).toHaveTextContent("Listening for language");
    expect(screen.getByText("What language does the other person most likely speak?")).toHaveClass(
      "bootstrap-title",
    );
    expect(screen.getByRole("button", { name: "Skip" })).toHaveClass(
      "setup-secondary-action",
    );
  });

  it("shows a clear startup progress state while interpreter activation is in flight", () => {
    const controller = new MobileUiController();
    controller.session = { ...controller.session, state: "bootstrap" };
    controller.bootstrapText = "Spanish";
    controller.isInterpreterStarting = true;

    render(<ContextScreen controller={controller} />);

    expect(screen.getByText("Starting translator…")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled();
  });
});
