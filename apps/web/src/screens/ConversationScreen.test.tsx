import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionReducer } from "../session/sessionReducer";
import type { Side, Turn } from "../conversation/Turn";
import type { DialogueBlock } from "../conversation/DialogueTranscript";
import type { LifecycleSuspendReason, RecoveryPrompt } from "../session/SessionController";
import {
  createInitialSession,
  type TranslationSession,
} from "../session/SessionState";
import { ConversationScreen, type ConversationScreenController } from "./ConversationScreen";

afterEach(cleanup);

const conversationCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "./ConversationScreen.css"),
  "utf8",
);

function participant(side: Side) {
  return { side, hasAcceptedConversationSpeech: false };
}

function turn(overrides: Partial<Turn> & Pick<Turn, "id" | "speaker">): Turn {
  return {
    sideSource: "language",
    sourceFragments: [],
    originalText: "",
    status: "outputting",
    audioOutputStarted: false,
    ...overrides,
  };
}

function session(overrides: Partial<TranslationSession> = {}): TranslationSession {
  return {
    ...createInitialSession(participant("A"), participant("B")),
    state: "listening",
    ...overrides,
  };
}

class FakeConversationController implements ConversationScreenController {
  session: TranslationSession;
  captionBlocks: readonly DialogueBlock[] = [];
  inputReady = true;
  recoveryPrompt: RecoveryPrompt | undefined;
  recoveryPromptIsTurnFailure = false;
  ownerError: string | undefined;
  suspendReason: LifecycleSuspendReason | undefined;
  retainedRecoveryState: "paused" | "resuming" | "ending" | "failed" | "pending_end" | "pending_claim" | "blocked" | "unresolved_create" | undefined;
  readonly endConversation = vi.fn(async () => {});
  readonly cancel = vi.fn(async () => {});
  readonly resumeFromSourceTimeout = vi.fn(async () => {});
  readonly resumeRetainedConversation = vi.fn(async () => {});
  readonly verifyRetainedConversation = vi.fn(async () => {});
  private readonly listeners = new Set<() => void>();

  constructor(initial: TranslationSession = session()) {
    this.session = initial;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

describe("default independent captions", () => {
  afterEach(() => { window.history.replaceState({}, "", "/"); });

  it("shows the full dialogue on each pane without legacy waiting rows or duplicated unknown text", () => {
    window.history.replaceState({}, "", "/");
    const controller = new FakeConversationController(session({
      participantA: { ...participant("A"), language: "ru" },
      participantB: { ...participant("B"), language: "en" },
      activeTurn: turn({ id: "service", speaker: "A", originalText: "Legacy text" }),
    }));
    controller.recoveryPrompt = "repeat";
    controller.recoveryPromptIsTurnFailure = true;
    controller.captionBlocks = [
      { id: "1", kind: "input", side: "A", language: "ru", text: "Кто вы?", receivedAtMs: 1 },
      { id: "2", kind: "output", side: "B", language: "en", text: "Who are you?", receivedAtMs: 2 },
      { id: "3", kind: "input", side: "B", language: "en", text: "I'm a courier.", receivedAtMs: 3 },
      { id: "4", kind: "output", side: "A", language: "ru", text: "Я курьер.", receivedAtMs: 4 },
      { id: "5", kind: "output", text: "OK", receivedAtMs: 5 },
    ];
    render(<ConversationScreen controller={controller} />);
    const a = screen.getByTestId("participant-pane-A"), b = screen.getByTestId("participant-pane-B");
    expect([...a.querySelectorAll("li")].map(row => row.textContent)).toEqual(["Я: Кто вы?", "Он: Я курьер."]);
    expect([...b.querySelectorAll("li")].map(row => row.textContent)).toEqual(["Him: Who are you?", "Me: I'm a courier."]);
    expect(a).not.toHaveTextContent("OK");
    expect(b).not.toHaveTextContent("OK");
    expect(document.querySelector(".unassigned-captions")).toHaveTextContent("OK");
    expect(screen.queryByText(/Текст без определённого языка/)).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy text")).not.toBeInTheDocument();
    expect(screen.queryByText("Повторите")).not.toBeInTheDocument();
    expect(document.querySelector(".turn-waiting")).toBeNull();
  });

  it("preserves repeat guidance after a real lifecycle interruption", () => {
    window.history.replaceState({}, "", "/?captions=blocks");
    const controller = new FakeConversationController(session());
    controller.recoveryPrompt = "repeat";
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByText("Повторите")).toBeVisible();
  });

  it.each(["/", "/?captions=blocks", "/?captions=legacy"])("preserves uncertain text outside the panes until it resolves at %s", url => {
    window.history.replaceState({}, "", url);
    const controller = new FakeConversationController(session({
      participantB: { ...participant("B"), language: "en" },
    }));
    controller.captionBlocks = [{ id: "pending", kind: "output", text: "Um", receivedAtMs: 1 }];
    const view = render(<ConversationScreen controller={controller} />);
    expect(document.querySelector(".unassigned-captions")).toHaveTextContent("Um");
    expect(document.querySelectorAll(".participant-pane li")).toHaveLength(0);
    expect(screen.queryByText(/Текст без определённого языка/)).not.toBeInTheDocument();
    controller.captionBlocks = [{ id: "pending", kind: "output", side: "B", language: "en", text: "Um, I have a package for you.", receivedAtMs: 1 }];
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByText("Um, I have a package for you.").closest("li")).toHaveTextContent("Him:");
    expect(document.querySelectorAll(".participant-pane li")).toHaveLength(1);
  });
});

describe("ConversationScreen orientation and status", () => {
  it("does not render again when subscribing to an unchanged controller", () => {
    let renders = 0;
    render(<Profiler id="conversation" onRender={() => { renders++; }}><ConversationScreen controller={new FakeConversationController()} /></Profiler>);
    expect(renders).toBe(1);
  });
  it("catches a recovery change between render and subscription", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    const subscribe = controller.subscribe.bind(controller);
    controller.subscribe = listener => { controller.retainedRecoveryState = "paused"; return subscribe(listener); };
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Продолжить разговор" })).toBeInTheDocument();
  });
  it("describes pending claims as a resume that can create a paid attempt", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    controller.retainedRecoveryState = "pending_claim";
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("новую оплачиваемую попытку");
    expect(screen.getByRole("button", { name: "Продолжить разговор" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Проверить восстановление" })).not.toBeInTheDocument();
  });
  it("keeps recoverable action slots present and Resume primary while busy", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    controller.retainedRecoveryState = "paused";
    const view = render(<ConversationScreen controller={controller} />);
    const resume = screen.getByRole("button", { name: "Продолжить разговор" });
    const end = screen.getByRole("button", { name: "Завершить сохранённый разговор" });
    expect(resume).toHaveClass("retained-recovery__primary");
    expect(end).toHaveClass("retained-recovery__danger");
    controller.retainedRecoveryState = "resuming";
    view.rerender(<ConversationScreen controller={controller} />);
    expect(resume).toBeInTheDocument();
    expect(resume).toBeDisabled();
    expect(end).toBeInTheDocument();
    expect(end).toBeDisabled();
  });
  it("offers retained resume from a paused interpreter screen", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    controller.retainedRecoveryState = "paused";
    render(<ConversationScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить разговор" }));
    expect(controller.resumeRetainedConversation).toHaveBeenCalledOnce();
  });
  it("announces retained End as ending and disables both actions", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    controller.retainedRecoveryState = "ending";
    render(<ConversationScreen controller={controller} />);
    expect(screen.getAllByRole("status")).toContain(screen.getByText("Завершаем сохранённый разговор…"));
    expect(screen.getByRole("button", { name: "Завершить сохранённый разговор" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Продолжить разговор" })).not.toBeInTheDocument();
  });
  it("keeps the active conversation End button while closing and offers recovery if End stays pending", () => {
    const controller = new FakeConversationController(session({
      activeTurn: turn({ id: "closing-turn", speaker: "A", originalText: "Hello" }),
    }));
    controller.captionBlocks = [{ id: "closing", kind: "input", side: "A", language: "en", text: "Hello", receivedAtMs: 1 }];
    const view = render(<ConversationScreen controller={controller} />);
    const end = screen.getByRole("button", { name: "Завершить" });
    fireEvent.click(end);
    controller.session = { ...controller.session, state: "ending" };
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Завершаю…" })).toBe(end);
    expect(end).toBeDisabled();
    expect(end).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".retained-recovery")).toBeNull();
    expect(screen.getByTestId("participant-pane-A")).toHaveTextContent("Hello");

    controller.retainedRecoveryState = "pending_end";
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Завершение не подтверждено");
    expect(screen.getByRole("button", { name: "Повторить проверку" })).toBeEnabled();
  });
  it("shows the same pending End recovery without claiming the interpreter is ready", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    controller.retainedRecoveryState = "pending_end";
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Завершение не подтверждено");
    expect(screen.queryByText("Говорите")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить проверку" }));
    expect(controller.verifyRetainedConversation).toHaveBeenCalledOnce();
  });
  it("keeps keyboard focus on an action after retained resume completes", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    controller.retainedRecoveryState = "paused";
    const view = render(<ConversationScreen controller={controller} />);
    screen.getByRole("button", { name: "Продолжить разговор" }).focus();
    controller.retainedRecoveryState = undefined;
    controller.session = session({ state: "listening" });
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("button", { name: "Завершить" })).toHaveFocus();
  });
  it("keeps A LISTENING when A is still source-active and early GPT output exists, B TRANSLATING/SPEAKING, B rotated 180deg", () => {
    const controller = new FakeConversationController(
      session({
        state: "outputting",

        activeTurn: turn({
          id: "t-early",
          speaker: "A",
          originalText: "Where is apartment 12?",
          translatedText: "¿Dónde está el apartamento 12?",
          status: "outputting",
          audioOutputStarted: true,
        }),
      }),
    );

    render(<ConversationScreen controller={controller} />);

    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Слушаю");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent(/Перевожу|Перевод/);
    expect(screen.getByTestId("participant-pane-B")).toHaveStyle({
      transform: "rotate(180deg)",
    });
  });

  it("fills the phone viewport and keeps B at the physical top", () => {
    const controller = new FakeConversationController();
    render(<ConversationScreen controller={controller} />);

    const root = document.querySelector(".conversation-screen");
    expect(root).not.toBeNull();
    expect(conversationCss).toMatch(/\.conversation-screen\s*\{[^}]*height:\s*100svh/s);
    expect(conversationCss).toMatch(/\.conversation-screen\s*\{[^}]*height:\s*100dvh/s);
    expect(conversationCss).toMatch(/\.conversation-screen\s*\{[^}]*overflow:\s*hidden/s);
    expect(conversationCss).toMatch(/\.participant-pane\s*\{[^}]*box-sizing:\s*border-box/s);
    expect(conversationCss).toMatch(/\.participant-pane\s*\{[^}]*min-width:\s*0/s);
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    const panes = [...root!.querySelectorAll("[data-testid^='participant-pane-']")];
    expect(panes[0]).toHaveAttribute("data-testid", "participant-pane-B");
    expect(screen.getByTestId("participant-pane-B")).toHaveStyle({
      transform: "rotate(180deg)",
    });
  });

  it("lets either participant speak while idle", () => {
    const controller = new FakeConversationController(
      session({ state: "listening" }),
    );
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Говорите");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Говорите");
  });

  it("does not show YOUR TURN while the expected source input is not ready", () => {
    const controller = new FakeConversationController(
      session({ state: "listening" }),
    );
    controller.inputReady = false;

    render(<ConversationScreen controller={controller} />);

    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("Говорите");
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Ожидание");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Ожидание");
  });

  it("does not show LISTENING or YOUR TURN after connection-loss error", () => {
    const controller = new FakeConversationController(
      session({
        state: "error",

        activeTurn: turn({
          id: "t-lost",
          speaker: "A",
          originalText: "Hello",
          status: "streaming",
        }),
      }),
    );
    controller.ownerError = "Unable to continue the live connection.";

    render(<ConversationScreen controller={controller} />);

    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("Слушаю");
    expect(screen.getByTestId("participant-status-B")).not.toHaveTextContent("Слушаю");
    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("Говорите");
    expect(screen.getByTestId("participant-status-B")).not.toHaveTextContent("Говорите");
    expect(screen.getByTestId("participant-pane-A")).toHaveTextContent(
      "Unable to continue the live connection.",
    );
    expect(screen.getByTestId("participant-pane-B")).toHaveTextContent(
      "Unable to continue the live connection.",
    );
    expect(screen.getByTestId("participant-pane-B")).toHaveStyle({
      transform: "rotate(180deg)",
    });
  });

  it("does not show LISTENING or YOUR TURN while ending", () => {
    const controller = new FakeConversationController(
      session({
        state: "ending",

        activeTurn: turn({
          id: "t-end",
          speaker: "A",
          originalText: "Hello",
          status: "streaming",
        }),
      }),
    );
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("Слушаю");
    expect(screen.getByTestId("participant-status-B")).not.toHaveTextContent("Слушаю");
    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("Говорите");
    expect(screen.getByTestId("participant-status-B")).not.toHaveTextContent("Говорите");
  });

  it("shows PAUSED on both panes while suspended", () => {
    const suspended = new FakeConversationController(session({ state: "suspended" }));
    render(<ConversationScreen controller={suspended} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Пауза");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Пауза");
  });
});

describe("caption history, languages and authors", () => {
  function bilingualController() {
    return new FakeConversationController(session({
      participantA: { ...participant("A"), language: "ru" },
      participantB: { ...participant("B"), language: "en" },
    }));
  }

  it("keeps long captions in a keyboard-accessible scroller", () => {
    const controller = bilingualController();
    const text = "T".repeat(200);
    controller.captionBlocks = [{ id: "long", kind: "output", side: "B", language: "en", text, receivedAtMs: 1 }];
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByText(text)).toHaveClass("recent-turn-primary");
    expect(screen.getByTestId("participant-pane-B")).toHaveStyle({ overflow: "hidden" });
    expect(screen.getByTestId("participant-scroll-B")).toHaveAttribute("tabindex", "0");
  });

  it("retains identified text across operational failures without adding waiting rows", () => {
    const controller = bilingualController();
    controller.captionBlocks = [
      { id: "source", kind: "input", side: "A", language: "ru", text: "Где вокзал?", receivedAtMs: 1 },
      { id: "reply", kind: "input", side: "B", language: "en", text: "The station is ahead.", receivedAtMs: 2 },
    ];
    const view = render(<ConversationScreen controller={controller} />);
    controller.session = { ...controller.session, recentTurns: [turn({ id: "failed", speaker: "A", originalText: "Где вокзал?", status: "failed" })] };
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByText("Где вокзал?").closest("li")).toHaveTextContent("Я:");
    expect(document.querySelectorAll(".recent-turn")).toHaveLength(2);
    expect(document.querySelector(".turn-waiting")).toBeNull();
    controller.captionBlocks = [...controller.captionBlocks,
      { id: "late-output", kind: "output", side: "B", language: "en", text: "Where is the station?", receivedAtMs: 3 },
    ];
    view.rerender(<ConversationScreen controller={controller} />);
    const b = screen.getByTestId("participant-pane-B");
    expect([...b.querySelectorAll("li")].map(row => row.textContent)).toEqual([
      "Me: The station is ahead.", "Him: Where is the station?",
    ]);
    expect(screen.getByTestId("participant-pane-A")).not.toHaveTextContent("Where is the station?");
  });

  it("keeps all supplied blocks in order with both relative authors and original language tags", () => {
    const controller = bilingualController();
    controller.captionBlocks = Array.from({ length: 60 }, (_, i): DialogueBlock => ({
      id: String(i), kind: i % 4 < 2 ? "input" : "output", side: i % 2 === 0 ? "A" : "B",
      language: i % 2 === 0 ? "ru" : "en", text: `Caption ${i}`, receivedAtMs: i,
    }));
    render(<ConversationScreen controller={controller} />);
    for (const side of ["A", "B"] as const) {
      const pane = screen.getByTestId(`participant-scroll-${side}`);
      const blocks = controller.captionBlocks.filter(block => block.side === side);
      expect([...pane.querySelectorAll(".recent-turn-primary")].map(node => node.textContent)).toEqual(blocks.map(block => block.text));
      expect(pane.querySelectorAll("li")).toHaveLength(30);
      for (const block of blocks) {
        const text = within(pane).getByText(block.text);
        expect(text).toHaveAttribute("lang", block.language);
        expect(text.closest("li")).toHaveTextContent(side === "A"
          ? block.kind === "input" ? "Я:" : "Он:"
          : block.kind === "input" ? "Me:" : "Him:");
      }
    }
  });

  it("shows translation-only blocks only on their recipient pane", () => {
    const controller = bilingualController();
    controller.captionBlocks = [{ id: "output", kind: "output", side: "B", language: "en", text: "Thank you, I will walk there.", receivedAtMs: 1 }];
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("participant-pane-A").querySelectorAll("li")).toHaveLength(0);
    expect(screen.getByText("Thank you, I will walk there.").closest("li")).toHaveTextContent("Him:");
  });

  it("shows each participant language and exposes independent participant status", () => {
    const controller = bilingualController();
    const view = render(<ConversationScreen controller={controller} />);
    for (const [side, description] of [["A", "русский"], ["B", "English"]] as const) {
      const pane = within(screen.getByTestId(`participant-pane-${side}`));
      expect(pane.getByText(description)).toBeInTheDocument();
      const status = pane.getByTestId(`participant-status-${side}`);
      expect(status).toHaveAttribute("role", "status");
      expect(status.closest("button")).toBeNull();
    }
    controller.session = { ...controller.session, participantB: { ...controller.session.participantB, language: undefined } };
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("participant-pane-B").querySelector(".participant-language")).toBeNull();
  });

  it("localizes controls independently and preserves old text and its language after a language change", () => {
    const controller = bilingualController();
    controller.captionBlocks = [{ id: "old", kind: "output", side: "B", language: "en", text: "Thank you", receivedAtMs: 1 }];
    const view = render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Говорите");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Speak");
    expect(screen.getByRole("button", { name: "Завершить" })).toBeInTheDocument();
    controller.session = { ...controller.session, participantB: { ...controller.session.participantB, language: "de" } };
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByText("Thank you")).toHaveAttribute("lang", "en");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Sprechen Sie");
    expect(screen.getByTestId("participant-pane-B").querySelectorAll("li")).toHaveLength(1);
  });

  it.each([
    ["en", "Speak", "Me"], ["fr", "Parlez", "Moi"], ["it", "Parla", "Io"],
    ["de", "Sprechen Sie", "Ich"], ["es", "Habla", "Yo"], ["pt", "Fale", "Eu"],
    ["ru", "Говорите", "Я"], ["ja", "Speak", "Me"],
  ])("uses %s pane copy (English fallback) without changing speech text", (language, status, author) => {
    const controller = bilingualController();
    controller.session = { ...controller.session, participantB: { ...participant("B"), language } };
    controller.captionBlocks = [{ id: "native", kind: "input", side: "B", language: "ja", text: "日本語の発話", receivedAtMs: 1 }];
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent(status);
    expect(screen.getByTestId("participant-pane-B").querySelector("li")).toHaveTextContent(author);
    expect(screen.getByText("日本語の発話")).toHaveAttribute("lang", "ja");
    if (language === "ja") expect(screen.getByTestId("participant-pane-B")).toHaveAttribute("lang", "en");
  });

  it("localizes common errors and retained recovery to A's language", () => {
    const controller = new FakeConversationController(session({
      participantA: { ...participant("A"), language: "en" }, state: "suspended",
    }));
    controller.ownerError = "Для перевода нужен доступ к микрофону.";
    const view = render(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone access is required for translation.");
    controller.retainedRecoveryState = "pending_claim";
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("new paid attempt");
    expect(screen.getByRole("button", { name: "Continue conversation" })).toBeEnabled();
  });
});

describe("ConversationScreen actions", () => {
  it("keeps participant labels static and captions keyboard-scrollable", () => {
    const controller = new FakeConversationController(session({
      participantA: { ...participant("A"), language: "ru" },
      participantB: { ...participant("B"), language: "en" },
    }));
    render(<ConversationScreen controller={controller} />);

    for (const side of ["A", "B"]) {
      const pane = screen.getByTestId(`participant-pane-${side}`);
      expect(within(pane).queryByRole("button")).not.toBeInTheDocument();
      expect(pane.querySelector(".participant-language")?.tagName).toBe("SPAN");
      expect(screen.getByTestId(`participant-scroll-${side}`)).toHaveAttribute("tabindex", "0");
    }
  });

  it("End conversation calls endConversation", () => {
    const controller = new FakeConversationController();
    render(<ConversationScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    expect(controller.endConversation).toHaveBeenCalledOnce();
  });

  it("surfaces resume-repeat and calls resumeFromSourceTimeout", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    controller.recoveryPrompt = "resume-repeat";
    render(<ConversationScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить / повторить" }));
    expect(controller.resumeFromSourceTimeout).toHaveBeenCalledOnce();
  });

  it("surfaces the repeat prompt without a resume control", () => {
    const controller = new FakeConversationController();
    controller.recoveryPrompt = "repeat";
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByText("Повторите")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Продолжить / повторить" })).not.toBeInTheDocument();
  });

  it("renders ErrorOverlay with the explicit message", () => {
    const controller = new FakeConversationController();
    controller.ownerError = "Live session closed unexpectedly.";
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Live session closed unexpectedly.");
  });

  it("shows a blocking portrait-oriented rotate overlay only for orientation suspend", () => {
    const oriented = new FakeConversationController(session({ state: "suspended" }));
    oriented.suspendReason = "orientation";
    const { unmount } = render(<ConversationScreen controller={oriented} />);
    const overlay = screen.getByTestId("rotate-overlay");
    expect(overlay).toHaveTextContent("Поверните телефон вертикально");
    expect(overlay).toHaveStyle({ transform: "none" });
    expect(screen.queryByTestId("rotate-overlay")).toBeInTheDocument();
    unmount();

    const hidden = new FakeConversationController(session({ state: "suspended" }));
    hidden.suspendReason = "visibility";
    render(<ConversationScreen controller={hidden} />);
    expect(screen.queryByTestId("rotate-overlay")).not.toBeInTheDocument();
  });
});

it.each([undefined, "idle", "speaking"])("shows pending A playback on B with newer source %s", state => {
  const controller = new FakeConversationController(session({
    state: "outputting",
    pendingTurns: [turn({ id: "old-a", speaker: "A", sourceIdleAtMs: 1, audioOutputStarted: true })],
    activeTurn: state === undefined ? undefined : turn({ id: "new-b", speaker: "B", sourceIdleAtMs: state === "idle" ? 2 : undefined }),
  }));
  render(<ConversationScreen controller={controller} />);
  expect(screen.getByTestId("participant-status-B")).toHaveTextContent(state === "speaking" ? "Слушаю" : "Перевод");
  expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Ожидание");
});
it.each(["ended", "interrupted", "completed"])("does not show stale pending audio as playing when %s", state => {
  const controller = new FakeConversationController(session({ pendingTurns: [turn({
    id: "old-a", speaker: "A", sourceIdleAtMs: 1, audioOutputStarted: true, translatedText: "Hola.",
    playbackEndAtMs: state === "ended" ? 10 : undefined,
    audioOutputInterrupted: state === "interrupted", status: state === "completed" ? "completed" : "outputting",
  })] }));
  render(<ConversationScreen controller={controller} />);
  expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Говорите");
});
it("shows late pending translation text on its recipient while another source is idle", () => {
  const controller = new FakeConversationController(session({
    pendingTurns: [turn({ id: "old-a", speaker: "A", sourceIdleAtMs: 1, translatedText: "Hola." })],
    activeTurn: turn({ id: "new-b", speaker: "B", sourceIdleAtMs: 2 }),
  }));
  render(<ConversationScreen controller={controller} />);
  expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Перевожу");
  expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Ожидание");
});

it("shows each recipient its own unfinished output when both sides have translations", () => {
  const controller = new FakeConversationController(session({
    pendingTurns: [turn({ id: "old-a", speaker: "A", sourceIdleAtMs: 1, translatedText: "Hola." })],
    activeTurn: turn({ id: "new-b", speaker: "B", sourceIdleAtMs: 2, translatedText: "Hello.", audioOutputStarted: true }),
  }));
  render(<ConversationScreen controller={controller} />);
  expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Перевод");
  expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Перевожу");
});


it.each(["active", "pending"].flatMap(location => (["PLAYBACK_ENDED", "AUDIO_INTERRUPTED"] as const).flatMap(edge => [1000, 1050].map(nowMs => ({ location, edge, nowMs })))))("shows fresh text at $nowMs after $edge for a $location source", ({ location, edge, nowMs }) => {
  const source = turn({ id: "a", speaker: "A", translatedText: "Hola.", audioOutputStarted: true,
    outputTextEndAtMs: 900, sourceIdleAtMs: location === "pending" ? 1 : undefined });
  const controller = new FakeConversationController(session(location === "active"
    ? { activeTurn: source } : { pendingTurns: [source] }));
  controller.session = sessionReducer(controller.session, { type: edge, turnId: "a", nowMs: 1000 });
  const view = render(<ConversationScreen controller={controller} />);
  expect(screen.getByTestId("participant-status-B")).toHaveTextContent(location === "active" ? "Ожидание" : "Говорите");
  controller.session = sessionReducer(controller.session, { type: "OUTPUT_DELTA", turnId: "a", text: " Más.", nowMs });
  view.rerender(<ConversationScreen controller={controller} />);
  expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Перевожу");
  expect(screen.getByTestId("participant-status-A")).toHaveTextContent(location === "active" ? "Слушаю" : "Ожидание");
  expect((controller.session.activeTurn ?? controller.session.pendingTurns![0])?.playbackEndAtMs).toBe(1000);
  expect((controller.session.activeTurn ?? controller.session.pendingTurns![0])?.audioOutputInterrupted).toBe(edge === "AUDIO_INTERRUPTED" ? true : undefined);
  controller.session = sessionReducer(controller.session, { type: edge, turnId: "a", nowMs });
  view.rerender(<ConversationScreen controller={controller} />);
  expect(screen.getByTestId("participant-status-B")).toHaveTextContent(location === "active" ? "Ожидание" : "Говорите");
  expect((controller.session.activeTurn ?? controller.session.pendingTurns![0])?.translatedText).toBe("Hola. Más.");
});

describe("conversation controls", () => {
  it.each(["listening", "outputting", "suspended", "ending"] as const)("has no playback switch and keeps captions visible while %s", state => {
    const controller = new FakeConversationController(session({
      state,
      activeTurn: turn({ id: "a", speaker: "A", translatedText: "Hello" }),
    }));
    controller.captionBlocks = [{ id: "translation", kind: "output", side: "B", language: "en", text: "Hello", receivedAtMs: 1 }];
    render(<ConversationScreen controller={controller} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Язык собеседника" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Hello/).length).toBeGreaterThan(0);
  });
});
