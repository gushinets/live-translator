import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  ownerError: string | undefined;
  hasEnteredInterpreter = false;
  isConnectInFlight = false;
  isInterpreterStarting = false;
  audioElement: HTMLAudioElement | undefined;
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

  skipBootstrap = vi.fn(() => {});

  acceptBootstrap = vi.fn((text: string) => {
    void text;
  });

  beginInterpreter = vi.fn(async () => {});

  correctLastTurn = vi.fn(async () => {});

  endConversation = vi.fn(async () => {});

  resumeFromSourceTimeout = vi.fn(async () => {});

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
  it("treats context as optional and always shows the privacy disclosure", () => {
    render(<ContextScreen controller={new FakeOwnerController()} />);

    expect(
      screen.getByRole("button", { name: "Tell me the context (optional)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Speech is sent to OpenAI for live translation. This app does not save conversation history. OpenAI API data-handling rules still apply.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start translation" }),
    ).toBeEnabled();
  });

  it("lets the user edit and clear recognized context", () => {
    const controller = new FakeOwnerController();
    controller.contextText = "I'm Russian and a courier is at my door.";
    controller.session = { ...controller.session, state: "context" };

    render(<ContextScreen controller={controller} />);

    const editor = screen.getByRole("textbox", { name: "Context" });
    expect(editor).toHaveValue("I'm Russian and a courier is at my door.");

    fireEvent.change(editor, { target: { value: "Hotel check-in in Madrid." } });
    expect(controller.contextText).toBe("Hotel check-in in Madrid.");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(controller.contextText).toBe("");
    expect(screen.getByRole("textbox", { name: "Context" })).toHaveValue("");
  });

  it("enters bootstrap from Start even when context is empty", async () => {
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: "Start translation" }));

    expect(controller.session.state).toBe("bootstrap");
    expect(
      await screen.findByText("What language does the other person most likely speak?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Listening automatically. Ask them to say the language."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "microphone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Say the language" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.querySelector("select")).toBeNull();
  });

  it("Skip begins interpreter without accepting a language hint", async () => {
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: "Start translation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));

    expect(controller.skipBootstrap).toHaveBeenCalledOnce();
    expect(controller.acceptBootstrap).not.toHaveBeenCalled();
    expect(controller.beginInterpreter).toHaveBeenCalledOnce();
  });

  it("shows Accept only after bootstrap transcript exists and uses that hint", async () => {
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: "Start translation" }));
    await screen.findByRole("button", { name: "Skip" });

    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(controller.acceptBootstrap).not.toHaveBeenCalled();
    expect(controller.beginInterpreter).not.toHaveBeenCalled();

    act(() => {
      controller.setBootstrapText("Spanish");
    });
    expect(screen.getByText("Recognized language hint")).toBeInTheDocument();
    expect(screen.getByText("Spanish")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect(controller.acceptBootstrap).toHaveBeenCalledExactlyOnceWith("Spanish");
    expect(controller.beginInterpreter).toHaveBeenCalledOnce();
  });

  it("traces accept and skip boundaries without bootstrap content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    localStorage.setItem(STARTUP_TRACE_STORAGE_KEY, "1");
    const controller = new FakeOwnerController();
    render(<ContextScreen controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: "Start translation" }));
    await screen.findByRole("button", { name: "Skip" });
    act(() => {
      controller.setBootstrapText("translate a private medical transcript");
    });

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    const output = info.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain('"event":"ui.bootstrap.skip_invoked"');
    expect(output).toContain('"event":"ui.bootstrap.accept_invoked"');
    expect(output).toContain('"action":"skip"');
    expect(output).toContain('"action":"accept"');
    expect(output).not.toContain("private medical transcript");
  });

  it("mounts the Gate C audio element in the document", () => {
    const controller = new FakeOwnerController();
    controller.audioElement = document.createElement("audio");

    render(<ContextScreen controller={controller} />);

    expect(controller.audioElement).toBeInTheDocument();
  });

  it("disables Skip and Accept while interpreter start is in flight and keeps Cancel enabled", async () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "bootstrap" };
    controller.bootstrapText = "Spanish";
    controller.isInterpreterStarting = true;

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows Cancel while connect is in flight from idle", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "idle" };
    controller.isConnectInFlight = true;

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start translation" })).toBeDisabled();
  });

  it("shows ownerError after a connect failure and keeps Cancel enabled", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "idle" };
    controller.ownerError = "Microphone access is required for translation.";

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone access is required for translation.",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows startup errors on the owner screen instead of conversation", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "error" };
    controller.ownerError = "Unable to start live translation.";

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("button", { name: "Start translation" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to start live translation.");
    expect(screen.queryByRole("button", { name: "End conversation" })).not.toBeInTheDocument();
  });

  it("keeps in-conversation errors on ConversationScreen", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "error" };
    controller.hasEnteredInterpreter = true;
    controller.ownerError = "Unable to continue the live connection.";

    render(<ContextScreen controller={controller} />);

    expect(screen.getByRole("button", { name: "End conversation" })).toBeInTheDocument();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent("Unable to continue the live connection.");
    expect(alerts[1]).toHaveTextContent("Unable to continue the live connection.");
    expect(screen.queryByRole("button", { name: "Start translation" })).not.toBeInTheDocument();
  });

  it("shows the conversation screen instead of the interpreter stub once listening", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "listening" };

    render(<ContextScreen controller={controller} />);

    expect(screen.queryByText("Interpreter active")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End conversation" })).toBeInTheDocument();
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
      screen.getByRole("heading", { level: 1, name: "Live Translator" }),
    ).toBeInTheDocument();
  });

  it("does not render an h1 during conversation", () => {
    const controller = new FakeOwnerController();
    controller.session = { ...controller.session, state: "listening" };

    render(<ContextScreen controller={controller} />);

    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End conversation" })).toBeInTheDocument();
  });
});
