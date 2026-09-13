import { afterEach, describe, expect, it, vi } from "vitest";
import { OrientationController } from "./OrientationController";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeScreen(options: {
  type?: string;
  lock?: (orientation: string) => Promise<void>;
}): Screen {
  const listeners = new Set<EventListener>();
  const orientation = {
    type: options.type,
    lock: options.lock,
    addEventListener: (_type: string, listener: EventListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: EventListener) => {
      listeners.delete(listener);
    },
    dispatch: () => {
      for (const listener of listeners) {
        listener(new Event("change"));
      }
    },
  };
  return {
    orientation,
  } as unknown as Screen;
}

describe("OrientationController", () => {
  it("reports portrait and landscape from screen.orientation.type", () => {
    const portrait = new OrientationController(
      fakeScreen({ type: "portrait-primary" }),
    );
    expect(portrait.getOrientation()).toBe("portrait");
    expect(portrait.isPortrait()).toBe(true);

    const landscape = new OrientationController(
      fakeScreen({ type: "landscape-secondary" }),
    );
    expect(landscape.getOrientation()).toBe("landscape");
    expect(landscape.isPortrait()).toBe(false);
  });

  it("throws when orientation cannot be read instead of inventing a fallback", () => {
    const controller = new OrientationController({} as Screen);
    expect(() => controller.getOrientation()).toThrow(/orientation/i);
  });

  it("calls screen.orientation.lock portrait when available", async () => {
    const lock = vi.fn(async () => {});
    const controller = new OrientationController(
      fakeScreen({ type: "portrait-primary", lock }),
    );

    await controller.lockPortrait();

    expect(lock).toHaveBeenCalledExactlyOnceWith("portrait");
  });

  it("ignores unsupported orientation lock failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const lock = vi.fn(async () => {
      throw new Error("lock is not available");
    });
    const controller = new OrientationController(
      fakeScreen({ type: "portrait-primary", lock }),
    );

    await expect(controller.lockPortrait()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("emits landscape on orientation change", () => {
    const screenRef = fakeScreen({ type: "portrait-primary" });
    const controller = new OrientationController(screenRef);
    const orientations: string[] = [];
    controller.onChange = (orientation) => {
      orientations.push(orientation);
    };
    controller.start();

    (screenRef.orientation as unknown as { type: string }).type = "landscape-primary";
    (
      screenRef.orientation as unknown as { dispatch: () => void }
    ).dispatch();

    expect(orientations).toEqual(["landscape"]);
    controller.stop();
  });
});
