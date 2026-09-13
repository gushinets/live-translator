/**
 * Best-effort screen wake lock. Never a correctness dependency: missing API
 * or request failure is logged and ignored.
 */
export class WakeLockController {
  private sentinel: WakeLockSentinel | null = null;

  constructor(private readonly nav: Navigator = navigator) {}

  async request(): Promise<void> {
    const wakeLock = this.nav.wakeLock;
    if (wakeLock === undefined || typeof wakeLock.request !== "function") {
      console.error("Screen wake lock is unsupported");
      return;
    }
    try {
      this.sentinel = await wakeLock.request("screen");
    } catch (error) {
      console.error("Screen wake lock request failed", { error });
    }
  }

  async reacquire(): Promise<void> {
    await this.request();
  }

  async release(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel === null || sentinel.released) {
      return;
    }
    try {
      await sentinel.release();
    } catch (error) {
      console.error("Screen wake lock release failed", { error });
    }
  }
}
