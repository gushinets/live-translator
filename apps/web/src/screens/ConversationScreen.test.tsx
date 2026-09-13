import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECENT_TURNS } from "../conversation/TurnBuffer";
import type { Side, Turn } from "../conversation/Turn";
import { currentMessageSizeClass } from "../components/ParticipantPane";
import type { RecoveryPrompt } from "../session/SessionController";
import {
  createInitialSession,
  type TranslationSession,
} from "../session/SessionState";
import { ConversationScreen, type ConversationScreenController } from "./ConversationScreen";

afterEach(cleanup);

function participant(side: Side) {
  return { side, hasAcceptedConversationSpeech: false };
}

function turn(overrides: Partial<Turn> & Pick<Turn, "id" | "speaker">): Turn {
  return {
    sideSource: "prior",
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
  recoveryPrompt: RecoveryPrompt | undefined;
  ownerError: string | undefined;
  readonly correctLastTurn = vi.fn(async (_side: Side) => {});
  readonly endConversation = vi.fn(async () => {});
  readonly resumeFromSourceTimeout = vi.fn(async () => {});
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
  it("keeps A LISTENING when A is still source-active and early GPT output exists, B TRANSLATING/SPEAKING, B rotated 180deg", () => {
    const controller = new FakeConversationController(
      session({
        state: "outputting",
        expectedSpeaker: "A",
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

    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("LISTENING");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent(/TRANSLATING|SPEAKING/);
    expect(screen.getByTestId("participant-pane-B")).toHaveStyle({
      transform: "rotate(180deg)",
    });
  });

  it("shows YOUR TURN on the expected idle source and WAITING on the recipient", () => {
    const controller = new FakeConversationController(
      session({ state: "listening", expectedSpeaker: "A" }),
    );
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("YOUR TURN");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("WAITING");
  });

  it("shows CORRECTING on both panes while correcting and PAUSED on both while suspended", () => {
    const correcting = new FakeConversationController(
      session({
        state: "correcting",
        activeTurn: turn({ id: "t-corr", speaker: "A", status: "correcting" }),
      }),
    );
    const { unmount } = render(<ConversationScreen controller={correcting} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("CORRECTING");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("CORRECTING");
    unmount();

    const suspended = new FakeConversationController(session({ state: "suspended" }));
    render(<ConversationScreen controller={suspended} />);
    expect(screen.getByTestId("participant-status-A")).toHaveTextContent("PAUSED");
    expect(screen.getByTestId("participant-status-B")).toHaveTextContent("PAUSED");
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

    fireEvent.click(screen.getByTestId("participant-pane-B"));
    expect(controller.correctLastTurn).toHaveBeenCalledExactlyOnceWith("B");
    fireEvent.click(screen.getByTestId("participant-pane-A"));
    expect(controller.correctLastTurn).toHaveBeenLastCalledWith("A");
  });

  it("End conversation calls endConversation", () => {
    const controller = new FakeConversationController();
    render(<ConversationScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "End conversation" }));
    expect(controller.endConversation).toHaveBeenCalledOnce();
  });

  it("surfaces resume-repeat and calls resumeFromSourceTimeout", () => {
    const controller = new FakeConversationController(session({ state: "suspended" }));
    controller.recoveryPrompt = "resume-repeat";
    render(<ConversationScreen controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume / Repeat" }));
    expect(controller.resumeFromSourceTimeout).toHaveBeenCalledOnce();
  });

  it("surfaces the repeat prompt without a resume control", () => {
    const controller = new FakeConversationController();
    controller.recoveryPrompt = "repeat";
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByText("Repeat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume / Repeat" })).not.toBeInTheDocument();
  });

  it("renders ErrorOverlay with the explicit message", () => {
    const controller = new FakeConversationController();
    controller.ownerError = "Live session closed unexpectedly.";
    render(<ConversationScreen controller={controller} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Live session closed unexpectedly.");
  });
});
