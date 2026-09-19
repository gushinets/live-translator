import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
  bootstrapSide = "A" as const;
  bootstrapRecording = true;
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
  async acceptBootstrap(): Promise<void> {}
  async beginInterpreter(): Promise<void> {}
  async cancel(): Promise<void> {}
  async correctLastTurn(): Promise<void> {}
  async endConversation(): Promise<void> {}
  async resumeFromSourceTimeout(): Promise<void> {}
}

describe("ContextScreen mobile setup UI", () => {
  it("renders a concise Russian owner screen without promotional copy", () => {
    render(<ContextScreen controller={new MobileUiController()} />);

    expect(screen.getByRole("heading", { name: "Переводчик" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Начать перевод" })).toBeInTheDocument();
    expect(screen.getByLabelText("Контекст")).toBeInTheDocument();
    expect(screen.queryByText(/One phone, two people/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ready when you are/i)).not.toBeInTheDocument();
  });

  it("renders setup as an accessible mobile app shell with a primary action", () => {
    render(<ContextScreen controller={new MobileUiController()} />);

    const setup = screen.getByRole("region", { name: "Настройка переводчика" });
    expect(setup).toHaveClass("setup-screen");
    expect(setup.querySelector(".setup-shell")).not.toBeNull();
    expect(setup.querySelector(".setup-card")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Начать перевод" })).toHaveClass(
      "setup-primary-action",
    );
    expect(screen.queryByText(/Речь обрабатывает OpenAI/i)).not.toBeInTheDocument();
  });

  it("renders bootstrap as a focused listening state", () => {
    const controller = new MobileUiController();
    controller.session = { ...controller.session, state: "bootstrap" };

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("status")).toHaveTextContent("Слушаю участника A");
    expect(screen.getByText("Образец речи A · 1 из 2")).toHaveClass(
      "bootstrap-title",
    );
    expect(screen.getByRole("button", { name: "Записать заново" })).toHaveClass(
      "setup-secondary-action",
    );
  });

  it("shows a clear startup progress state while interpreter activation is in flight", () => {
    const controller = new MobileUiController();
    controller.session = { ...controller.session, state: "bootstrap" };
    controller.bootstrapText = "Spanish";
    controller.isInterpreterStarting = true;

    render(<ContextScreen controller={controller} />);

    expect(screen.getByText("Сохраняю образец…")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Сохранить образец" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Записать заново" })).toBeDisabled();
  });
});
