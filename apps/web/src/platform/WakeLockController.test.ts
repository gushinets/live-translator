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

  it("reuses an active sentinel and reacquires after the browser releases it", async () => {
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

    expect(request).toHaveBeenCalledTimes(1);
    first.released = true;
    await controller.reacquire();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "screen");
    expect(request).toHaveBeenNthCalledWith(2, "screen");
    await controller.release();
    expect(first.release).not.toHaveBeenCalled();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("coalesces parallel requests so release owns every acquired lock", async () => {
    let resolve!: (sentinel: WakeLockSentinel) => void;
    const sentinel = { released: false, release: vi.fn(async () => {}) };
    const request = vi.fn(() => new Promise<WakeLockSentinel>(done => { resolve = done; }));
    const controller = new WakeLockController({ wakeLock: { request } } as unknown as Navigator);

    const first = controller.request(), second = controller.reacquire();
    expect(request).toHaveBeenCalledOnce();
    resolve(sentinel as unknown as WakeLockSentinel);
    await Promise.all([first, second]);
    await controller.release();
    await controller.release();
    expect(sentinel.release).toHaveBeenCalledOnce();
  });

  it("releases a late acquisition after End without replacing a new lock", async () => {
    let resolveOld!: (sentinel: WakeLockSentinel) => void;
    const old = { released: false, release: vi.fn(async () => {}) };
    const current = { released: false, release: vi.fn(async () => {}) };
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<WakeLockSentinel>(done => { resolveOld = done; }))
      .mockResolvedValueOnce(current);
    const controller = new WakeLockController({ wakeLock: { request } } as unknown as Navigator);

    const pending = controller.request();
    await controller.release();
    await controller.request();
    resolveOld(old as unknown as WakeLockSentinel);
    await pending;

    expect(old.release).toHaveBeenCalledOnce();
    expect(current.release).not.toHaveBeenCalled();
    await controller.reacquire();
    expect(request).toHaveBeenCalledTimes(2);
    await controller.release();
    expect(current.release).toHaveBeenCalledOnce();
  });

  it("allows a later request after acquisition fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sentinel = { released: false, release: vi.fn(async () => {}) };
    const request = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(sentinel);
    const controller = new WakeLockController({ wakeLock: { request } } as unknown as Navigator);
    await controller.request();
    await controller.request();
    expect(request).toHaveBeenCalledTimes(2);
    await controller.release();
    expect(sentinel.release).toHaveBeenCalledOnce();
  });
});
