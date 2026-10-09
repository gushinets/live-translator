import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialSession, type TranslationSession } from "../session/SessionState";
import type { DialogueBlock } from "../conversation/DialogueTranscript";
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
  captionBlocks: readonly DialogueBlock[] = [];
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
  retainedRecoveryState: "checking" | "paused" | "resuming" | "ending" | "failed" | "active" | "pending_end" | "pending_claim" | "blocked" | "unresolved_create" | "unavailable" | undefined;
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

  startWithLanguages = vi.fn(async ({ A, B }: { A: string; B: string }) => {
    this.session = { ...this.session, state: "listening",
      participantA: { ...this.session.participantA, language: A },
      participantB: { ...this.session.participantB, language: B } };
    this.notify();
  });

  acceptBootstrap = vi.fn(async (text: string) => {
    void text;
  });

  beginInterpreter = vi.fn(async () => {});


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
    this.captionBlocks = [];
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

describe("ContextScreen", () => {
  it("keeps both panes and their scroll positions after End until returning to the saved setup", async () => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "listening",
      participantA: { ...controller.session.participantA, language: "ru" },
      participantB: { ...controller.session.participantB, language: "en" } };
    controller.captionBlocks = [
      { id: "a", kind: "input", side: "A", language: "ru", text: "Добрый день.", receivedAtMs: 1 },
      { id: "b", kind: "output", side: "B", language: "en", text: "Good afternoon.", receivedAtMs: 2 },
    ];
    controller.endConversation.mockImplementation(async () => {
      controller.session = { ...controller.session, state: "ended" };
    });
    const view = render(<ContextScreen controller={controller} />);
    const scrollA = screen.getByTestId("participant-scroll-A");
    const scrollB = screen.getByTestId("participant-scroll-B");
    for (const scroll of [scrollA, scrollB]) {
      Object.defineProperty(scroll, "scrollHeight", { value: 1000 });
      Object.defineProperty(scroll, "clientHeight", { value: 200 });
      scroll.scrollTop = 120;
      fireEvent.scroll(scroll);
    }
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Завершить" })); });
    view.rerender(<ContextScreen controller={controller} />);
    expect(screen.getByTestId("participant-scroll-A")).toBe(scrollA);
    expect(screen.getByTestId("participant-scroll-B")).toBe(scrollB);
    expect(scrollA.scrollTop).toBe(120);
    expect(scrollB.scrollTop).toBe(120);
    expect(screen.getByText("Добрый день.")).toBeInTheDocument();
    expect(screen.getByText("Good afternoon.")).toBeInTheDocument();
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Разговор завершён");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Conversation ended");
    expect(screen.queryByRole("button", { name: "Завершить" })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "На начальный экран" })); });
    expect(screen.queryByTestId("participant-pane-A")).not.toBeInTheDocument();
    expect(controller.captionBlocks).toEqual([]);
    expect(screen.getByRole("button", { name: /^Ваш язык/ })).toHaveTextContent("русский");
    expect(screen.getByRole("button", { name: /^Язык собеседника/ })).toHaveTextContent("английский");
    expect(screen.getByRole("button", { name: "Начать перевод" })).toHaveFocus();
    expect(controller.startWithLanguages).not.toHaveBeenCalled();
  });

  it.each(["Ваш язык", "Язык собеседника"])("opens the saved language picker from the %s card", label => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);
    const card = screen.getByRole("button", { name: new RegExp(`^${label}`) });
    expect(card).toHaveTextContent(label === "Ваш язык" ? "русский" : "английский");
    fireEvent.click(card);
    expect(screen.getByRole("radio", { name: "английский" })).toBeChecked();
    if (label === "Ваш язык") {
      expect(screen.getByRole("combobox", { name: "Ваш язык" })).toHaveValue("ru");
    }
    expect(controller.startWithLanguages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    expect(controller.startWithLanguages).toHaveBeenCalledExactlyOnceWith({ A: "ru", B: "en" });
  });
  it("uses the selected owner language in setup and language choices", () => {
    localStorage.setItem("live-translator-owner-language", "en");
    localStorage.setItem("live-translator-interlocutor-language", "es");
    render(<ContextScreen controller={new FakeOwnerController()} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Partner's language" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Spanish" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Start translation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Your language" }), { target: { value: "de" } });
    expect(screen.getByRole("heading", { name: "Sprache des Partners" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Übersetzung starten" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Übersetzer einrichten" })).toHaveAttribute("lang", "de");
    fireEvent.change(screen.getByRole("combobox", { name: "Ihre Sprache" }), { target: { value: "" } });
    expect(screen.getByRole("region", { name: "Translator setup" })).toHaveAttribute("lang", "en");
    expect(screen.getByRole("button", { name: "Start translation" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Your language" }), { target: { value: "de" } });
    fireEvent.click(screen.getByRole("button", { name: "Einstellungen schließen" }));
    expect(screen.getByRole("region", { name: "Translator setup" })).toHaveAttribute("lang", "en");
    expect(localStorage.getItem("live-translator-owner-language")).toBe("en");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Partner's language" })).toBeInTheDocument();
  });

  it("uses the retained session's owner language rather than the device preference", () => {
    localStorage.setItem("live-translator-owner-language", "ru");
    const controller = new FakeOwnerController();
    controller.session.participantA.language = "pt";
    controller.retainedRecoveryState = "paused";
    render(<ContextScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Continuar conversa" })).toBeInTheDocument();
  });

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
  it.each(["pending_end", "blocked"] as const)("shows the audio buffer failure alongside %s recovery", recovery => {
    const controller = new FakeOwnerController();
    controller.retainedRecoveryState = recovery;
    controller.ownerError = "Не удалось сохранить звук перевода. Начните новый разговор.";
    const view = render(<ContextScreen controller={controller} />);
    expect(view.container.querySelector(".error-overlay")).toHaveTextContent(controller.ownerError);
    expect(view.container.querySelector(".retained-recovery")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Повторить проверку" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Начать перевод" })).not.toBeInTheDocument();
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
  it("shows large language choices immediately on the first screen", () => {
    render(<ContextScreen controller={new FakeOwnerController()} />);
    expect(screen.getByRole("heading", { name: "Язык собеседника" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "испанский" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Начать перевод" })).toBeEnabled();
    expect(screen.queryByLabelText("Контекст")).not.toBeInTheDocument();
  });

  it("prefers the device formatting locale when Chrome language order differs", () => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...original.call(this), locale: "ru-RU" };
    });
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    expect(controller.startWithLanguages).toHaveBeenCalledWith({ A: "ru", B: "es" });
  });

  it.each(["xx-ZZ", "es-ES"])("requires correction of a saved pair when owner locale becomes %s", locale => {
    localStorage.setItem("live-translator-interlocutor-language", "es");
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...original.call(this), locale };
    });
    Object.defineProperty(navigator, "languages", { configurable: true, value: [locale] });
    try {
      render(<ContextScreen controller={new FakeOwnerController()} />);
      const spanish = locale === "es-ES";
      expect(screen.getByRole("heading", { name: spanish ? "Idioma del interlocutor" : "Язык собеседника" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: spanish ? "Iniciar traducción" : "Начать перевод" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: spanish ? "Cerrar ajustes" : "Закрыть настройки" })).not.toBeInTheDocument();
      expect(document.querySelector(".setup-shell--start")).toBeNull();
    } finally { Reflect.deleteProperty(navigator, "languages"); }
  });

  it("puts six priority languages first and sorts the rest by Russian name without duplicates", () => {
    render(<ContextScreen controller={new FakeOwnerController()} />);
    const radios = screen.getAllByRole("radio", { name: /.+/ }) as HTMLInputElement[];
    expect(radios.slice(0, 6).map(radio => radio.value)).toEqual(["es", "en", "fr", "de", "it", "pt"]);
    expect(new Set(radios.map(radio => radio.value)).size).toBe(radios.length);
    const names = radios.slice(6).map(radio => radio.closest("label")!.textContent!);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "ru")));
    expect(radios.length).toBeGreaterThan(20);
  });

  it("starts on first tap without recording samples", () => {
    const controller = new FakeOwnerController();
    const startBootstrap = vi.spyOn(controller, "startBootstrap");
    render(<ContextScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    expect(startBootstrap).not.toHaveBeenCalled();
    expect(controller.startWithLanguages).toHaveBeenCalledOnce();
  });

  it("requires a different interlocutor language from the owner language", () => {
    const controller = new FakeOwnerController();
    localStorage.setItem("live-translator-owner-language", "es");
    render(<ContextScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Iniciar traducción" })).toBeDisabled();
    expect(controller.startWithLanguages).not.toHaveBeenCalled();
  });

  it("saves the choice and starts subsequent conversations in one click", async () => {
    const controller = new FakeOwnerController();
    const first = render(<ContextScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    expect(await screen.findByRole("button", { name: "Завершить" })).toBeInTheDocument();
    expect(localStorage.getItem("live-translator-interlocutor-language")).toBe("es");
    first.unmount();
    const next = new FakeOwnerController();
    render(<ContextScreen controller={next} />);
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    expect(next.startWithLanguages).toHaveBeenCalledOnce();
    expect(screen.queryByRole("radio", { name: "испанский" })).not.toBeInTheDocument();
  });

  it("keeps the large Start button in place while connecting and preparing translation", async () => {
    localStorage.setItem("live-translator-interlocutor-language", "es");
    const controller = new FakeOwnerController();
    let finishStart!: () => void;
    controller.startWithLanguages.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishStart = resolve;
    }));
    const view = render(<ContextScreen controller={controller} />);
    const start = screen.getByRole("button", { name: "Начать перевод" });
    fireEvent.click(start);

    const pending = screen.getByRole("button", { name: "Устанавливаю связь…" });
    expect(pending).toBe(start);
    expect(pending).toBeDisabled();
    expect(view.container.querySelector(".setup-card--start")).toContainElement(pending);
    fireEvent.click(pending);
    expect(controller.startWithLanguages).toHaveBeenCalledOnce();

    for (const state of ["connecting", "bootstrap"] as const) {
      controller.session = { ...controller.session, state };
      view.rerender(<ContextScreen controller={controller} />);
      expect(screen.getByRole("button", { name: "Устанавливаю связь…" })).toBe(start);
      expect(view.container.querySelector(".setup-card--start")).toContainElement(start);
      expect(screen.queryByText("Запускаю перевод…")).not.toBeInTheDocument();
    }

    await act(async () => {
      controller.session = { ...controller.session, state: "listening" };
      finishStart();
    });
    expect(screen.getByRole("button", { name: "Завершить" })).toBeInTheDocument();
  });

  it("keeps the selected language when the first connection fails", async () => {
    const controller = new FakeOwnerController();
    controller.startWithLanguages.mockRejectedValueOnce(new Error("offline"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = render(<ContextScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(localStorage.getItem("live-translator-interlocutor-language")).toBe("es");
    first.unmount();

    const retry = new FakeOwnerController();
    render(<ContextScreen controller={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    expect(retry.startWithLanguages).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ B: "es" }));
  });

  it("reopens the saved language from the start-screen settings", () => {
    localStorage.setItem("live-translator-interlocutor-language", "es");
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);
    expect(screen.queryByRole("radio", { name: "испанский" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    expect(screen.getByRole("radio", { name: "испанский" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть настройки" }));
    expect(screen.queryByRole("radio", { name: "испанский" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    fireEvent.click(screen.getByRole("radio", { name: "французский" }));
    fireEvent.click(screen.getByRole("button", { name: "Начать перевод" }));
    expect(controller.startWithLanguages).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ B: "fr" }));
    expect(localStorage.getItem("live-translator-interlocutor-language")).toBe("fr");
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
    expect(screen.queryByRole("button", { name: "Язык собеседника" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

  it("shows the language heading on the first start screen", () => {
    render(<ContextScreen controller={new FakeOwnerController()} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Язык собеседника" }),
    ).toBeInTheDocument();
  });

  it("does not render an h1 during conversation", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "listening" };

    render(<ContextScreen controller={controller} />);

    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText("Live Translator")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Завершить" })).toBeInTheDocument();
  });
});
