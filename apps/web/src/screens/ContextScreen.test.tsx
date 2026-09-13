import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionState } from "../session/SessionState";
import { ContextScreen, type ContextScreenController } from "./ContextScreen";

afterEach(cleanup);

class FakeOwnerController implements ContextScreenController {
  session: { state: SessionState } = { state: "idle" };
  contextText = "";
  bootstrapText = "";
  ownerError: string | undefined;
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

  skipBootstrap(): void {}

  acceptBootstrap(text: string): void {
    void text;
  }

  async beginInterpreter(): Promise<void> {}

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
});
