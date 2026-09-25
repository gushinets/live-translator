import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialSession, type TranslationSession } from "../session/SessionState";
import { STARTUP_TRACE_STORAGE_KEY } from "../live/StartupTrace";
import { ContextScreen, type ContextScreenController } from "./ContextScreen";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function idleSession(): TranslationSession {
  return createInitialSession(
    { side: "A", hasAcceptedConversationSpeech: false },
    { side: "B", hasAcceptedConversationSpeech: false },
  );
}

class FakeOwnerController implements ContextScreenController {
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
  retainedRecoveryState: "checking" | "paused" | "resuming" | "ending" | "failed" | "active" | "pending_end" | "pending_claim" | "blocked" | "unresolved_create" | undefined;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async startContextCapture(): Promise<void> {
    this.session = { ...this.session, state: "context" };
    this.notify();
  }

  finishContextCapture(): void {}

  setContextText(text: string): void {
    this.contextText = text;
    this.notify();
  }

  clearContext(): void {
    this.contextText = "";
    this.notify();
  }

  async startBootstrap(): Promise<void> {
    this.session = { ...this.session, state: "bootstrap" };
    this.bootstrapText = "";
    this.notify();
  }

  acceptBootstrap = vi.fn(async (text: string) => {
    void text;
  });

  beginInterpreter = vi.fn(async () => {});

  correctLastTurn = vi.fn(async () => {});

  endConversation = vi.fn(async () => {});

  resumeFromSourceTimeout = vi.fn(async () => {});
  resumeRetainedConversation = vi.fn(async () => {});
  verifyRetainedConversation = vi.fn(async () => {});

  setBootstrapText(text: string): void {
    this.bootstrapText = text;
    this.notify();
  }

  async cancel(): Promise<void> {
    this.session = { ...this.session, state: "idle" };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

describe("ContextScreen", () => {
  it("does not render again when subscribing to an unchanged controller", () => {
    let renders = 0;
    render(<Profiler id="setup" onRender={() => { renders++; }}><ContextScreen controller={new FakeOwnerController()} /></Profiler>);
    expect(renders).toBe(1);
  });
  it("catches a recovery change between render and subscription", () => {
    const controller = new FakeOwnerController();
    const subscribe = controller.subscribe.bind(controller);
    controller.subscribe = listener => { controller.retainedRecoveryState = "paused"; return subscribe(listener); };
    render(<ContextScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Продолжить разговор" })).toBeInTheDocument();
  });
  it("keeps an unresolved create blocked without impossible recovery actions", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "unresolved_create";
    render(<ContextScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("не удалось подтвердить");
    expect(screen.queryByRole("button", { name: "Повторить проверку" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Завершить сохранённый разговор" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Начать перевод" })).not.toBeInTheDocument();
  });
  it("reserves the first action slot while initial recovery is checking", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "checking";
    const view = render(<ContextScreen controller={controller} />);
    const actions = view.container.querySelector(".retained-recovery__actions")!;
    expect(actions.firstElementChild).toHaveClass("retained-recovery__placeholder");
    const end = screen.getByRole("button", { name: "Завершить сохранённый разговор" });
    expect(end).toBeDisabled();
    controller.retainedRecoveryState = "paused";
    view.rerender(<ContextScreen controller={controller} />);
    expect(actions.firstElementChild).toHaveTextContent("Продолжить разговор");
    expect(actions.lastElementChild).toBe(end);
  });
  it("focuses the bootstrap action after retained recovery clears", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "paused";
    const view = render(<ContextScreen controller={controller} />);
    screen.getByRole("button", { name: "Продолжить разговор" }).focus();
    controller.retainedRecoveryState = undefined;
    controller.bootstrapRecording = false;
    controller.session = { ...controller.session, state: "bootstrap" };
    view.rerender(<ContextScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Записать образец A" })).toHaveFocus();
  });
  it("focuses the enabled repeat action when bootstrap Save is disabled", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "paused";
    const view = render(<ContextScreen controller={controller} />);
    screen.getByRole("button", { name: "Продолжить разговор" }).focus();
    controller.retainedRecoveryState = undefined;
    controller.session = { ...controller.session, state: "bootstrap" };
    view.rerender(<ContextScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Записать заново" })).toHaveFocus();
  });
  it("offers a keyboard-accessible retained resume without starting a new conversation", async () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "failed";
    const startBootstrap = vi.spyOn(controller, "startBootstrap");
    render(<ContextScreen controller={controller} />);

    const retry = screen.getByRole("button", { name: "Повторить восстановление" });
    retry.focus();
    fireEvent.keyDown(retry, { key: "Enter" });
    fireEvent.click(retry);

    expect(controller.resumeRetainedConversation).toHaveBeenCalledOnce();
    expect(startBootstrap).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Начать перевод" })).not.toBeInTheDocument();
  });
  it("offers only End for an active retained conversation", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "active";
    render(<ContextScreen controller={controller} />);
    expect(screen.queryByRole("button", { name: "Повторить восстановление" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Начать перевод" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Завершить сохранённый разговор" }));
    expect(controller.endConversation).toHaveBeenCalledOnce();
  });
  it("announces retained End as ending and disables both actions", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "ending";
    render(<ContextScreen controller={controller} />);
    expect(screen.getByRole("status")).toHaveTextContent("Завершаем сохранённый разговор…");
    expect(screen.getByRole("button", { name: "Завершить сохранённый разговор" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Продолжить разговор" })).not.toBeInTheDocument();
  });
  it("blocks setup while End proof is pending and offers an explicit retry", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "pending_end";
    render(<ContextScreen controller={controller} />);
    expect(screen.queryByRole("button", { name: "Начать перевод" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Завершение не подтверждено");
    fireEvent.click(screen.getByRole("button", { name: "Повторить проверку" }));
    expect(controller.verifyRetainedConversation).toHaveBeenCalledOnce();
  });
  it("prevents competing End while a verification request is pending", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "pending_end";
    controller.verifyRetainedConversation.mockImplementation(() => new Promise<void>(() => {}));
    render(<ContextScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Повторить проверку" }));
    fireEvent.click(screen.getByRole("button", { name: "Завершить сохранённый разговор" }));
    expect(screen.getByRole("button", { name: "Завершить сохранённый разговор" })).toBeDisabled();
    expect(controller.endConversation).not.toHaveBeenCalled();
  });
  it("keeps an uncertain retained conversation blocked with verification and safe End", async () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "blocked";
    render(<ContextScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось проверить сохранённый разговор");
    fireEvent.click(screen.getByRole("button", { name: "Повторить проверку" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Завершить сохранённый разговор" }));
    expect(controller.verifyRetainedConversation).toHaveBeenCalledOnce();
    expect(controller.endConversation).toHaveBeenCalledOnce();
  });
  it("returns focus to Start after confirmed recovery clears the blocked controls", () => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = "pending_end";
    const view = render(<ContextScreen controller={controller} />);
    screen.getByRole("button", { name: "Повторить проверку" }).focus();
    controller.retainedRecoveryState = undefined;
    view.rerender(<ContextScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Начать перевод" })).toHaveFocus();
  });
  it("treats context as optional without extra footer copy", () => {
    render(<ContextScreen controller={new FakeOwnerController()} />);

    expect(
      screen.getByRole("button", { name: "Продиктовать контекст" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Речь обрабатывает OpenAI/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Начать перевод" }),
    ).toBeEnabled();
  });

  it("lets the user edit and clear recognized context", () => {
    const controller = new FakeOwnerController();
    controller.contextText = "I'm Russian and a courier is at my door.";
    controller.session = { ...controller.session, state: "context" };

    render(<ContextScreen controller={controller} />);

    const editor = screen.getByRole("textbox", { name: "Контекст" });
    expect(editor).toHaveValue("I'm Russian and a courier is at my door.");

    fireEvent.change(editor, { target: { value: "Hotel check-in in Madrid." } });
    expect(controller.contextText).toBe("Hotel check-in in Madrid.");

    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    expect(controller.contextText).toBe("");
    expect(screen.getByRole("textbox", { name: "Контекст" })).toHaveValue("");
  });

  it("enters bootstrap from Start even when context is empty", async () => {
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));

    expect(controller.session.state).toBe("bootstrap");
    expect(
      await screen.findByText("Образец речи A · 1 из 2"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Произнесите полное предложение на своём языке. Не называйте язык — просто расскажите что-нибудь."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Записать заново" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "microphone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Say the language" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.querySelector("select")).toBeNull();
  });

  it("does not offer a way to skip language calibration", async () => {
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    expect(await screen.findByRole("button", { name: "Сохранить образец" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Пропустить" })).not.toBeInTheDocument();
    expect(controller.beginInterpreter).not.toHaveBeenCalled();
  });

  it("enables saving a sample after transcript arrives without starting the interpreter", async () => {
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    await screen.findByRole("button", { name: "Записать заново" });

    expect(screen.getByRole("button", { name: "Сохранить образец" })).toBeDisabled();
    expect(controller.acceptBootstrap).not.toHaveBeenCalled();
    expect(controller.beginInterpreter).not.toHaveBeenCalled();

    act(() => {
      controller.setBootstrapText("Spanish");
    });
    expect(screen.getByText("Распознано")).toBeInTheDocument();
    expect(screen.getByText("Spanish")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Сохранить образец" }));

    expect(controller.acceptBootstrap).toHaveBeenCalledExactlyOnceWith("Spanish");
    expect(controller.beginInterpreter).not.toHaveBeenCalled();
  });

  it("starts only from the screen showing both fixed languages and does not trace speech", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    localStorage.setItem(STARTUP_TRACE_STORAGE_KEY, "1");
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "bootstrap",
      participantA: { ...controller.session.participantA, language: "ru" },
      participantB: { ...controller.session.participantB, language: "en" } };
    controller.bootstrapText = "private sample";
    render(<ContextScreen controller={controller} />);
    expect(screen.getByText("Участник A — русский")).toBeInTheDocument();
    expect(screen.getByText("Участник B — английский")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Начать разговор" }));
    expect(controller.beginInterpreter).toHaveBeenCalledOnce();
    const output = info.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain('"event":"ui.bootstrap.accept_invoked"');
    expect(output).not.toContain("private sample");
  });

  it("mounts the Gate C audio element in the document", () => {
    const controller = new FakeOwnerController();
    controller.audioElement = document.createElement("audio");

    render(<ContextScreen controller={controller} />);

    expect(controller.audioElement).toBeInTheDocument();
  });

  it("disables sample actions while saving is in flight and keeps Cancel enabled", async () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "bootstrap" };
    controller.bootstrapText = "Spanish";
    controller.isInterpreterStarting = true;

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("button", { name: "Записать заново" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Сохранить образец" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeEnabled();
  });

  it("shows Cancel while connect is in flight from idle", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "idle" };
    controller.isConnectInFlight = true;

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("button", { name: "Отмена" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Начать перевод" })).toBeDisabled();
  });

  it("shows ownerError after a connect failure and keeps Cancel enabled", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "idle" };
    controller.ownerError = "Microphone access is required for translation.";

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone access is required for translation.",
    );
    expect(screen.getByRole("button", { name: "Отмена" })).toBeEnabled();
  });

  it("shows startup errors on the owner screen instead of conversation", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "error" };
    controller.ownerError = "Unable to start live translation.";

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("button", { name: "Начать перевод" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to start live translation.");
    expect(screen.queryByRole("button", { name: "Завершить" })).not.toBeInTheDocument();
  });

  it("keeps in-conversation errors on ConversationScreen", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "error" };
    controller.hasEnteredInterpreter = true;
    controller.ownerError = "Unable to continue the live connection.";

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("button", { name: "Завершить" })).toBeInTheDocument();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent("Unable to continue the live connection.");
    expect(alerts[1]).toHaveTextContent("Unable to continue the live connection.");
    expect(screen.queryByRole("button", { name: "Начать перевод" })).not.toBeInTheDocument();
  });

  it("shows the conversation screen instead of the interpreter stub once listening", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "listening" };

    render(<ContextScreen controller={controller} />);

    expect(screen.queryByText("Interpreter active")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Завершить" })).toBeInTheDocument();
    expect(screen.getByTestId("participant-pane-B")).toHaveStyle({
      transform: "rotate(180deg)",
    });
  });

  it("traces the conversation render predicate outcome", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    localStorage.setItem(STARTUP_TRACE_STORAGE_KEY, "1");
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "listening" };
    controller.hasEnteredInterpreter = true;

    render(<ContextScreen controller={controller} />);

    const output = info.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain('"event":"ui.conversation.render_predicate"');
    expect(output).toContain('"state":"listening"');
    expect(output).toContain('"is_conversation":true');
    expect(output).toContain('"rendered_screen":"conversation"');
  });

  it("shows the translator title on the owner start screen", () => {
    render(<ContextScreen controller={new FakeOwnerController()} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Переводчик" }),
    ).toBeInTheDocument();
  });

  it("does not render an h1 during conversation", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "listening" };

    render(<ContextScreen controller={controller} />);

    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Завершить" })).toBeInTheDocument();
  });
});
