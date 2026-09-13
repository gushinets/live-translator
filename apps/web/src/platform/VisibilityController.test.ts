import { describe, expect, it } from "vitest";
import { VisibilityController } from "./VisibilityController";

function fakeDocument(initial: DocumentVisibilityState) {
  let visibilityState = initial;
  const listeners = new Map<string, Set<EventListener>>();
  const doc = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    setVisibility(state: DocumentVisibilityState) {
      visibilityState = state;
      for (const listener of listeners.get("visibilitychange") ?? []) {
        listener(new Event("visibilitychange"));
      }
    },
  };
  return doc;
}

describe("VisibilityController", () => {
  it("notifies hidden and visible from visibilitychange", () => {
    const doc = fakeDocument("visible");
    const controller = new VisibilityController(doc as unknown as Document);
    const events: string[] = [];
    controller.onHidden = () => {
      events.push("hidden");
    };
    controller.onVisible = () => {
      events.push("visible");
    };
    controller.start();

    expect(controller.isHidden()).toBe(false);
    doc.setVisibility("hidden");
    expect(controller.isHidden()).toBe(true);
    doc.setVisibility("visible");
    expect(controller.isHidden()).toBe(false);
    expect(events).toEqual(["hidden", "visible"]);
    controller.stop();
  });

  it("throws when visibility state cannot be read", () => {
    const controller = new VisibilityController({
      visibilityState: "prerender",
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Document);
    expect(() => controller.isHidden()).toThrow(/visibility/i);
  });
});
