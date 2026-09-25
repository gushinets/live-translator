import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECENT_TURNS } from "../conversation/TurnBuffer";
import type { Side, Turn } from "../conversation/Turn";
import { currentMessageSizeClass } from "../components/ParticipantPane";
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
    corrected: false,
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
  retainedRecoveryState: "paused" | "resuming" | "ending" | "failed" | undefined;
  readonly correctLastTurn = vi.fn<(side: Side) => Promise<void>>(async () => {});
  readonly endConversation = vi.fn(async () => {});
  readonly resumeFromSourceTimeout = vi.fn(async () => {});
  readonly resumeRetainedConversation = vi.fn(async () => {});
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
    expect(screen.getByRole("status")).toHaveTextContent("Завершаем…");
    expect(screen.getByRole("button", { name: "Завершить" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Продолжить разговор" })).not.toBeInTheDocument();
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

    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("СЛУШАЮ");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent(/ПЕРЕВОЖУ|ПЕРЕВОД/);
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
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("ГОВОРИТЕ");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("ГОВОРИТЕ");
  });

  it("does not show YOUR TURN while the expected source input is not ready", () => {
    const controller = new FakeConversationController(
      session({ state: "listening" }),
    );
    controller.inputReady = false;

    render(<ConversationScreen controller={controller} />);

    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("ГОВОРИТЕ");
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("ОЖИДАНИЕ");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("ОЖИДАНИЕ");
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

    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("СЛУШАЮ");
    expect(screen.getByTestId("participant-status-B")).not.toHaveTextContent("СЛУШАЮ");
    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("ГОВОРИТЕ");
    expect(screen.getByTestId("participant-status-B")).not.toHaveTextContent("ГОВОРИТЕ");
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
    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("СЛУШАЮ");
    expect(screen.getByTestId("participant-status-B")).not.toHaveTextContent("СЛУШАЮ");
    expect(screen.getByTestId("participant-status-A")).not.toHaveTextContent("ГОВОРИТЕ");
    expect(screen.getByTestId("participant-status-B")).not.toHaveTextContent("ГОВОРИТЕ");
  });

  it("shows CORRECTING on both panes while correcting and PAUSED on both while suspended", () => {
    const correcting = new FakeConversationController(
      session({
        state: "correcting",
        activeTurn: turn({ id: "t-corr", speaker: "A", status: "correcting" }),
      }),
    );
    const { unmount } = render(<ConversationScreen controller={correcting} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("ИСПРАВЛЯЮ");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("ИСПРАВЛЯЮ");
    unmount();

    const suspended = new FakeConversationController(session({ state: "suspended" }));
    render(<ConversationScreen controller={suspended} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("ПАУЗА");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("ПАУЗА");
  });
});

describe("ConversationScreen typography and clarification", () => {
  it("hides overflow on the current message, wraps, sizes by character length, and does not nest a scroll area on B", () => {
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
    expect(primaryB).toHaveClass(currentMessageSizeClass(translatedText.length));
    expect(primaryB).toHaveTextContent(translatedText);
    expect(screen.getByTestId("participant-pane-B")).toHaveStyle({ overflow: "hidden" });
    expect(screen.getByTestId("participant-pane-B").querySelector("[style*='overflow: auto']")).toBeNull();
    expect(screen.getByTestId("participant-pane-B").querySelector("[style*='overflow: scroll']")).toBeNull();
  });

  it("mirrors current model output small on the source pane and large on the recipient pane", () => {
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
    expect(screen.getByTestId("current-secondary-A")).toHaveTextContent("¿Cuál es el código?");
    expect(screen.getByTestId("current-primary-B")).toHaveTextContent("¿Cuál es el código?");
    expect(screen.getByTestId("current-secondary-B")).toHaveTextContent("The code is 4512");
    expect(screen.getByTestId("current-secondary-A")).toHaveClass("current-secondary");
    expect(screen.getByTestId("current-primary-B")).toHaveClass("current-message");
  });

  it("mutes older turns and caps visible history at MAX_RECENT_TURNS", () => {
    const recentTurns = [1, 2, 3, 4].map((index) =>
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
    expect(muted).toHaveLength(MAX_RECENT_TURNS * 2);
    expect(screen.queryByText("original 1")).not.toBeInTheDocument();
    expect(screen.getAllByText("original 4")).toHaveLength(2);
  });
});

describe("ConversationScreen actions", () => {
  it("keeps the pane readable and gives correction its own native button", () => {
    const controller = new FakeConversationController();
    render(<ConversationScreen controller={controller} />);

    const sideA = screen.getByTestId("participant-pane-A");
    expect(sideA).not.toHaveAttribute("role", "button");
    expect(sideA).not.toHaveAttribute("tabindex");

    fireEvent.click(screen.getByRole("button", { name: "Исправить: говорил участник A" }));
    expect(controller.correctLastTurn).toHaveBeenCalledExactlyOnceWith("A");
  });

  it("taps invoke correctLastTurn for that side", () => {
    const controller = new FakeConversationController(
      session({
        state: "outputting",
        activeTurn: turn({
          id: "t-tap",
          speaker: "A",
          originalText: "Hello",
          translatedText: "Hola",
        }),
      }),
    );
    render(<ConversationScreen controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: "Исправить: говорил участник B" }));
    expect(controller.correctLastTurn).toHaveBeenCalledExactlyOnceWith("B");
    fireEvent.click(screen.getByRole("button", { name: "Исправить: говорил участник A" }));
    expect(controller.correctLastTurn).toHaveBeenLastCalledWith("A");
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
