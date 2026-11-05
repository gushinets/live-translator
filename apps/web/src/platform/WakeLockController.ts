/**
 * Best-effort screen wake lock. Never a correctness dependency: missing API
 * or request failure is logged and ignored.
 */
export class WakeLockController {
  private sentinel: WakeLockSentinel | null = null;
  private requestWork: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly nav: Navigator = navigator) {}

  async request(): Promise<void> {
    if (this.sentinel !== null && !this.sentinel.released) return;
    if (this.requestWork !== null) return this.requestWork;
    const wakeLock = this.nav.wakeLock;
    if (wakeLock === undefined || typeof wakeLock.request !== "function") {
      console.error("Screen wake lock is unsupported");
      return;
    }
    const generation = this.generation;
    const work = (async () => {
      try {
        const sentinel = await wakeLock.request("screen");
        if (generation !== this.generation) await this.releaseSentinel(sentinel);
        else this.sentinel = sentinel;
      } catch (error) {
        console.error("Screen wake lock request failed", { error });
      }
    })();
    this.requestWork = work;
    try { await work; }
    finally { if (this.requestWork === work) this.requestWork = null; }
  }

  async reacquire(): Promise<void> {
    await this.request();
  }

  async release(): Promise<void> {
    this.generation++;
    this.requestWork = null;
    const sentinel = this.sentinel;
    this.sentinel = null;
    await this.releaseSentinel(sentinel);
  }

  private async releaseSentinel(sentinel: WakeLockSentinel | null): Promise<void> {
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
