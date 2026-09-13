import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeLockController } from "./WakeLockController";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WakeLockController", () => {
  it("requests a screen wake lock when the API exists", async () => {
    const sentinel = { released: false, release: vi.fn(async () => {}) };
    const request = vi.fn(async () => sentinel);
    const controller = new WakeLockController({
      wakeLock: { request },
    } as unknown as Navigator);

    await controller.request();

    expect(request).toHaveBeenCalledExactlyOnceWith("screen");
  });

  it("ignores unsupported wake lock and continues", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new WakeLockController({} as Navigator);

    await expect(controller.request()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("ignores wake lock request failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    const controller = new WakeLockController({
      wakeLock: { request },
    } as unknown as Navigator);

    await expect(controller.request()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("reacquires by requesting again after a previous sentinel", async () => {
    const first = { released: false, release: vi.fn(async () => {}) };
    const second = { released: false, release: vi.fn(async () => {}) };
    const request = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const controller = new WakeLockController({
      wakeLock: { request },
    } as unknown as Navigator);

    await controller.request();
    await controller.reacquire();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "screen");
    expect(request).toHaveBeenNthCalledWith(2, "screen");
  });
});
