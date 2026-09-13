import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../session/SessionState";
import { ContextScreen, type ContextScreenController } from "./ContextScreen";

afterEach(cleanup);

class FakeOwnerController implements ContextScreenController {
  session: { state: SessionState } = { state: "idle" };
  contextText = "";
  bootstrapText = "";
  ownerError: string | undefined;
  isConnectInFlight = false;
  audioElement: HTMLAudioElement | undefined;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async startContextCapture(): Promise<void> {
    this.session = { state: "context" };
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
    this.session = { state: "bootstrap" };
    this.bootstrapText = "";
    this.notify();
  }

  skipBootstrap = vi.fn(() => {});

  acceptBootstrap = vi.fn((text: string) => {
    void text;
  });

  beginInterpreter = vi.fn(async () => {});

  setBootstrapText(text: string): void {
    this.bootstrapText = text;
    this.notify();
  }

  async cancel(): Promise<void> {
    this.session = { state: "idle" };
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

    expect(screen.getByText(/Tell me the context/i)).toBeInTheDocument();
    expect(screen.getByText(/optional/i)).toBeInTheDocument();
    expect(
      screen.getByText("Speech is sent to OpenAI for live translation."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start translation" }),
    ).toBeEnabled();
  });

  it("lets the user edit and clear recognized context", () => {
    const controller = new FakeOwnerController();
    controller.contextText = "I'm Russian and a courier is at my door.";
    controller.session = { state: "context" };

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
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.getByText("Say the language")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "microphone" }));
    expect(controller.acceptBootstrap).not.toHaveBeenCalled();
    expect(controller.beginInterpreter).not.toHaveBeenCalled();

    controller.setBootstrapText("Spanish");
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect(controller.acceptBootstrap).toHaveBeenCalledExactlyOnceWith("Spanish");
    expect(controller.beginInterpreter).toHaveBeenCalledOnce();
  });

  it("mounts the Gate C audio element in the document", () => {
    const controller = new FakeOwnerController();
    controller.audioElement = document.createElement("audio");

    render(<ContextScreen controller={controller} />);

    expect(controller.audioElement).toBeInTheDocument();
  });
});
