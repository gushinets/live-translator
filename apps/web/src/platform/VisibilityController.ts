/**
 * Document visibility. Hidden/background is a suspend reason; visible
 * revalidates before resume. Unknown visibility states fail closed.
 */
export class VisibilityController {
  onHidden: (() => void) | null = null;
  onVisible: (() => void) | null = null;

  private readonly handleVisibilityChange = (): void => {
    if (this.isHidden()) {
      this.onHidden?.();
      return;
    }
    this.onVisible?.();
  };

  constructor(private readonly doc: Document = document) {}

  isHidden(): boolean {
    const state = this.doc.visibilityState;
    if (state !== "visible" && state !== "hidden") {
      throw new Error(`Document visibility state is unavailable: ${String(state)}`);
    }
    return state === "hidden";
  }

  start(): void {
    this.doc.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  stop(): void {
    this.doc.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }
}
