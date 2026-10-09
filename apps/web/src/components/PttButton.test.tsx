import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PttButton, type PttControl } from "./PttButton";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const controller: PttControl = {
    pttHeld: false, pttCanStart: true, pttAwaitingRelease: false,
    pressPtt: vi.fn(() => { Object.assign(controller, { pttHeld: true }); return true; }),
    releasePtt: vi.fn(() => { Object.assign(controller, { pttHeld: false }); }),
  };
  const view = render(<PttButton controller={controller} language="ru" />);
  const button = screen.getByRole("button", { name: "Удерживай и говори" });
  Object.assign(button, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
  const pointer = (type: string, id = 1, primary = true, target: Window | Element = button) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId: id, button: 0, isPrimary: primary });
    fireEvent(target, event);
  };
  return { controller, button, view, pointer };
}

describe("PTT control", () => {
  it("starts on pointerdown, captures one pointer and releases outside without cancellation", () => {
    const f = setup();
    f.pointer("pointerdown");
    f.view.rerender(<PttButton controller={f.controller} language="ru" />);
    expect(f.button).toHaveAttribute("aria-pressed", "true");
    expect(f.button).toHaveAccessibleName("Говорите…");
    f.pointer("pointerdown", 2); f.pointer("pointerup", 2);
    expect(f.controller.pressPtt).toHaveBeenCalledOnce();
    expect(f.controller.releasePtt).not.toHaveBeenCalled();
    f.pointer("pointerup", 1, true, window);
    expect(f.controller.releasePtt).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.button.setPointerCapture).toHaveBeenCalledWith(1);
    expect(f.button.releasePointerCapture).toHaveBeenCalledWith(1);
  });
  it.each(["pointercancel", "lostpointercapture"])("cancels exactly once on %s", type => {
    const f = setup(); f.pointer("pointerdown"); f.pointer(type); f.pointer("pointerup");
    expect(f.controller.releasePtt).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each(["blur", "pagehide", "hidden", "unmount"])("cancels on %s and never restores a hold", reason => {
    const f = setup(); f.pointer("pointerdown");
    if (reason === "unmount") f.view.unmount();
    else if (reason === "hidden") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      fireEvent(document, new Event("visibilitychange"));
    } else fireEvent(window, new Event(reason));
    f.pointer("pointerup");
    expect(f.controller.releasePtt).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.controller.pttHeld).toBe(false);
  });
  it.each([" ", "Enter"])("supports held %s without auto-repeat or duplicate pointer intervals", key => {
    const f = setup();
    fireEvent.keyDown(f.button, { key });
    fireEvent.keyDown(f.button, { key, repeat: true });
    f.pointer("pointerdown");
    expect(f.controller.pressPtt).toHaveBeenCalledOnce();
    fireEvent.keyUp(window, { key });
    expect(f.controller.releasePtt).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("disables unavailable capture and ignores non-primary touches", () => {
    const f = setup(); f.pointer("pointerdown", 2, false);
    expect(f.controller.pressPtt).not.toHaveBeenCalled();
    Object.assign(f.controller, { pttCanStart: false });
    f.view.rerender(<PttButton controller={f.controller} language="en" />);
    expect(f.button).toBeDisabled();
    expect(f.button).toHaveAccessibleName("Hold to speak");
  });
});
