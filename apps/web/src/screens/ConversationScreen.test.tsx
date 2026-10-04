import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Side, Turn } from "../conversation/Turn";
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
  inputReady = true;
  recoveryPrompt: RecoveryPrompt | undefined;
  ownerError: string | undefined;
  suspendReason: LifecycleSuspendReason | undefined;
  retainedRecoveryState: "paused" | "resuming" | "ending" | "failed" | "pending_end" | "pending_claim" | "blocked" | "unresolved_create" | undefined;
  readonly endConversation = vi.fn(async () => {});
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

describe("ConversationScreen typography and clarification", () => {

  it("keeps long messages at one size in a keyboard-accessible scroller on B", () => {
    const translatedText = "T".repeat(200);
    const controller = new FakeConversationController(
      session({
        state: "outputting",
        activeTurn: turn({
          id: "t-long",
          speaker: "A",
          originalText: "Where is apartment 12?",
          translatedText,
        }),
      }),
    );
    render(<ConversationScreen controller={controller} />);

    const primaryB = screen.getByTestId("current-primary-B");
    expect(primaryB).toHaveClass("current-message");
    expect(primaryB.className).toBe("current-message");
    expect(primaryB).toHaveTextContent(translatedText);
    expect(screen.getByTestId("participant-pane-B")).toHaveStyle({ overflow: "hidden" });
    expect(screen.getByTestId("participant-scroll-B")).toHaveAttribute("tabindex", "0");
  });

  it("keeps the last completed caption large until new text reaches each pane", () => {
    const previous = turn({ id: "previous", speaker: "A", originalText: "Спасибо", translatedText: "Thank you", status: "completed" });
    const controller = new FakeConversationController(session({ recentTurns: [previous] }));
    const view = render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("latest-primary-A")).toHaveTextContent("Спасибо");
    expect(screen.getByTestId("latest-primary-B")).toHaveTextContent("Thank you");
    controller.session = { ...controller.session, activeTurn: turn({ id: "next", speaker: "A", originalText: "Следующая фраза" }) };
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.queryByTestId("latest-primary-A")).not.toBeInTheDocument();
    expect(screen.getByTestId("latest-primary-B")).toHaveTextContent("Thank you");
    expect(screen.getByTestId("current-author-B")).toHaveTextContent("Он");
    controller.session = { ...controller.session, activeTurn: { ...controller.session.activeTurn!, translatedText: "Next sentence" } };
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.queryByTestId("latest-primary-B")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-primary-B")).toHaveTextContent("Next sentence");
  });

  it("does not promote failed or discarded captions over the last completed caption", () => {
    const controller = new FakeConversationController(session({ recentTurns: [
      turn({ id: "good", speaker: "A", originalText: "Завершённая фраза", status: "completed" }),
      turn({ id: "failed", speaker: "A", originalText: "Ошибка", status: "failed" }),
      turn({ id: "discarded", speaker: "A", originalText: "Отменено", status: "discarded" }),
    ] }));
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("latest-primary-A")).toHaveTextContent("Завершённая фраза");
  });

  it("shows only the original on the source pane and only the translation on the recipient pane", () => {
    const controller = new FakeConversationController(
      session({
        state: "outputting",
        activeTurn: turn({
          id: "t-mirror",
          speaker: "A",
          originalText: "The code is 4512",
          translatedText: "¿Cuál es el código?",
        }),
      }),
    );
    render(<ConversationScreen controller={controller} />);

    expect(screen.getByTestId("current-primary-A")).toHaveTextContent("The code is 4512");
    expect(screen.queryByTestId("current-secondary-A")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-primary-B")).toHaveTextContent("¿Cuál es el código?");
    expect(screen.queryByTestId("current-secondary-B")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-primary-B")).toHaveClass("current-message");
  });

  it("keeps the whole bilingual history in both scrollable panes", () => {
    const recentTurns = Array.from({ length: 30 }, (_, i) => i + 1).map((index) =>
      turn({
        id: `old-${index}`,
        speaker: index % 2 === 0 ? "B" : "A",
        originalText: `original ${index}`,
        translatedText: `translated ${index}`,
        status: "completed",
      }),
    );
    const controller = new FakeConversationController(
      session({
        state: "listening",
        recentTurns,
      }),
    );
    render(<ConversationScreen controller={controller} />);

    const muted = document.querySelectorAll(".recent-turn");
    expect(muted).toHaveLength(recentTurns.length * 2);
    for (const side of ["A", "B"] as const) {
      const pane = screen.getByTestId(`participant-scroll-${side}`);
      expect(pane.querySelectorAll("li")).toHaveLength(recentTurns.length);
      for (const entry of recentTurns) {
        expect(within(pane).getByText(entry.speaker === side ? entry.originalText : entry.translatedText!)).toBeInTheDocument();
      }
    }
  });
});

describe("per-participant language and authors (ANY-558 / ANY-559)", () => {
  function bilingualSession(overrides: Partial<TranslationSession> = {}) {
    return session({
      participantA: { ...participant("A"), language: "ru" },
      participantB: { ...participant("B"), language: "en" },
      ...overrides,
    });
  }

  it("keeps both speakers' text and authors relative to each pane, including history", () => {
    const controller = new FakeConversationController(bilingualSession({
      activeTurn: turn({ id: "active", speaker: "B", originalText: "Hello", translatedText: "Привет" }),
      recentTurns: [turn({ id: "old", speaker: "A", originalText: "Спасибо", translatedText: "Thank you" })],
    }));
    render(<ConversationScreen controller={controller} />);
    const a = within(screen.getByTestId("participant-pane-A"));
    const b = within(screen.getByTestId("participant-pane-B"));
    expect(a.getByTestId("current-primary-A")).toHaveTextContent("Привет");
    expect(a.getByTestId("current-author-A")).toHaveTextContent("Он");
    expect(b.getByTestId("current-primary-B")).toHaveTextContent("Hello");
    expect(b.getByTestId("current-author-B")).toHaveTextContent("Me");
    expect(a.getByText("Спасибо").closest("li")).toHaveTextContent("Я");
    expect(b.getByText("Thank you").closest("li")).toHaveTextContent("Him");
    expect(a.queryByText("Hello")).not.toBeInTheDocument();
    expect(b.queryByText("Привет")).not.toBeInTheDocument();
    expect(screen.getByTestId("participant-pane-A")).toHaveAttribute("lang", "ru");
    expect(screen.getByTestId("participant-pane-B")).toHaveAttribute("lang", "en");
  });

  it("shows each participant language and exposes independent participant status", () => {
    const controller = new FakeConversationController(bilingualSession());
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
    const b = screen.getByTestId("participant-pane-B");
    expect(b.querySelector(".participant-language")).toBeNull();
  });

  it("waits without exposing unidentified text or guessed authors, then updates both panes on language detection", () => {
    const controller = new FakeConversationController(bilingualSession({
      activeTurn: turn({ id: "unknown", speaker: undefined, originalText: "OK", translatedText: "Хорошо" }),
      recentTurns: [turn({ id: "old-unknown", speaker: undefined, originalText: "123", status: "failed" })],
    }));
    const view = render(<ConversationScreen controller={controller} />);
    expect(screen.queryByText("OK")).not.toBeInTheDocument();
    expect(screen.queryByText("123")).not.toBeInTheDocument();
    expect(screen.queryByTestId("current-author-A")).not.toBeInTheDocument();
    expect(screen.queryByTestId("current-author-B")).not.toBeInTheDocument();
    expect(screen.getByTestId("participant-pane-B")).toHaveTextContent("Waiting");
    controller.session = { ...controller.session, activeTurn: { ...controller.session.activeTurn!, speaker: "B" } };
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("current-author-A")).toHaveTextContent("Он");
    expect(screen.getByTestId("current-author-B")).toHaveTextContent("Me");
  });

  it("localizes each pane and common controls independently and preserves old text on a language change", () => {
    const controller = new FakeConversationController(bilingualSession({
      recentTurns: [turn({ id: "old", speaker: "A", originalText: "Спасибо", translatedText: "Thank you", status: "completed", languages: { A: "ru", B: "en" } })],
    }));
    const view = render(<ConversationScreen controller={controller} onChangeLanguage={() => {}} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("Говорите");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Speak");
    expect(screen.getByRole("button", { name: "Завершить" })).toBeInTheDocument();
    expect(screen.getByTestId("participant-pane-B")).toHaveTextContent("English");
    controller.session = { ...controller.session, participantB: { ...controller.session.participantB, language: "de" } };
    view.rerender(<ConversationScreen controller={controller} onChangeLanguage={() => {}} />);
    expect(screen.getByTestId("participant-pane-B")).toHaveTextContent("Thank you");
    expect(screen.getByText("Thank you")).toHaveAttribute("lang", "en");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("Sprechen Sie");
    expect(screen.getByTestId("participant-pane-B").querySelectorAll("li")).toHaveLength(1);
  });

  it("keeps known authors in current and history captions while their translation is pending", () => {
    const controller = new FakeConversationController(bilingualSession({
      activeTurn: turn({ id: "pending", speaker: "A", originalText: "Привет" }),
      recentTurns: [turn({ id: "old-pending", speaker: "B", originalText: "Hello", status: "completed" })],
    }));
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("current-author-B")).toHaveTextContent("Him");
    expect(screen.queryByTestId("current-primary-B")).not.toBeInTheDocument();
    const aHistory = screen.getByTestId("participant-pane-A").querySelector("li")!;
    expect(aHistory.querySelector(".turn-author")).toHaveTextContent("Он");
    expect(aHistory.querySelector(".turn-waiting")).toHaveTextContent("Ожидание");
  });

  it("marks Japanese speech with its language while author labels retain the English UI locale", () => {
    const speech = turn({ id: "ja", speaker: "B", originalText: "駅はどこですか", languages: { A: "ru", B: "ja" } });
    const controller = new FakeConversationController(bilingualSession({
      participantB: { ...participant("B"), language: "ja" },
      activeTurn: speech, recentTurns: [{ ...speech, id: "old-ja", status: "completed" }],
    }));
    render(<ConversationScreen controller={controller} />);
    const b = screen.getByTestId("participant-pane-B");
    expect(b).toHaveAttribute("lang", "en");
    expect(b.querySelector(".recent-turn-primary")).toHaveAttribute("lang", "ja");
    expect(screen.getByTestId("current-primary-B")).toHaveAttribute("lang", "ja");
    expect(b.querySelector("li .turn-author")).toHaveTextContent("Me");
  });

  it.each([
    ["en", "Speak", "Me"], ["fr", "Parlez", "Moi"], ["it", "Parla", "Io"],
    ["de", "Sprechen Sie", "Ich"], ["es", "Habla", "Yo"], ["pt", "Fale", "Eu"],
    ["ru", "Говорите", "Я"], ["ja", "Speak", "Me"],
  ])("uses %s pane copy (English fallback) without changing speech text", (language, status, author) => {
    const controller = new FakeConversationController(bilingualSession({
      participantB: { ...participant("B"), language },
      recentTurns: [turn({ id: "native", speaker: "B", originalText: "日本語の発話", translatedText: "Русский перевод", status: "completed" })],
    }));
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent(status);
    expect(screen.getByTestId("participant-pane-B").querySelector("li")).toHaveTextContent(author);
    expect(screen.getByTestId("participant-pane-B")).toHaveTextContent("日本語の発話");
  });

  it("localizes common errors and retained recovery to A's language", () => {
    const controller = new FakeConversationController(bilingualSession({
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

describe("non-interrupting playback switch", () => {
  it("is off by default, switches both ways, and keeps streamed captions visible", () => {
    const controller = Object.assign(new FakeConversationController(session({
      activeTurn: turn({ id: "a", speaker: "A", translatedText: "Hello" }),
    })), {
      nonInterrupting: false,
      setNonInterrupting(enabled: boolean) { this.nonInterrupting = enabled; controller.notify(); },
    });
    render(<ConversationScreen controller={controller} />);
    const toggle = screen.getByRole("switch", { name: "Не перебивать" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText(/Hello/).length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
  it("disables mode changes when suspended or ending", () => {
    const controller = Object.assign(new FakeConversationController(session({ state: "suspended" })), {
      nonInterrupting: true, setNonInterrupting: vi.fn(),
    });
    const view = render(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("switch", { name: "Не перебивать" })).toBeDisabled();
    controller.session = session({ state: "ending" });
    view.rerender(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("switch", { name: "Не перебивать" })).toBeDisabled();
  });
});
