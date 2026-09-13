export type DeviceOrientation = "portrait" | "landscape";

/**
 * Portrait-first orientation. Manifest requests portrait; runtime lock is
 * best-effort only. Landscape is a real suspend reason, not a fallback UI mode.
 */
export class OrientationController {
  onChange: ((orientation: DeviceOrientation) => void) | null = null;

  private readonly handleChange = (): void => {
    this.onChange?.(this.getOrientation());
  };

  constructor(private readonly screenRef: Screen = screen) {}

  getOrientation(): DeviceOrientation {
    const type = this.screenRef.orientation?.type;
    if (type === undefined || type.length === 0) {
      throw new Error("Screen orientation is unavailable");
    }
    if (type.startsWith("portrait")) {
      return "portrait";
    }
    if (type.startsWith("landscape")) {
      return "landscape";
    }
    throw new Error(`Unrecognized screen orientation "${type}"`);
  }

  isPortrait(): boolean {
    return this.getOrientation() === "portrait";
  }

  async lockPortrait(): Promise<void> {
    const orientation = this.screenRef.orientation as
      | (ScreenOrientation & { lock?: (lockType: string) => Promise<void> })
      | undefined;
    if (orientation === undefined || typeof orientation.lock !== "function") {
      console.error("Portrait orientation lock is unsupported", {
        hasOrientation: orientation !== undefined,
      });
      return;
    }
    try {
      await orientation.lock("portrait");
    } catch (error) {
      console.error("Portrait orientation lock failed", { error });
    }
  }

  start(): void {
    const orientation = this.screenRef.orientation;
    if (orientation === undefined) {
      console.error("Screen orientation API is unavailable");
      return;
    }
    orientation.addEventListener("change", this.handleChange);
  }

  stop(): void {
    this.screenRef.orientation?.removeEventListener("change", this.handleChange);
  }
}
