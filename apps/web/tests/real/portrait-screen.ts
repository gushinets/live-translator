import type { Page } from "@playwright/test";

const PORTRAIT_SCREEN = { width: 390, height: 844 };
const PASSIVE_DIAGNOSTIC_PREFIX = "[real-live-passive]";

export async function emulatePortraitScreen(page: Page): Promise<void> {
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith(PASSIVE_DIAGNOSTIC_PREFIX)) {
      console.log(text);
    }
  });

  await page.addInitScript(() => {
    interface AnalyserSampleState {
      calls: number;
      lastRms: number;
      minRms: number;
      maxRms: number;
      lastAtMs: number;
    }

    const prefix = "[real-live-passive]";
    const analyserStates = new Map<number, AnalyserSampleState>();
    let nextAnalyserId = 0;

    const originalCreateAnalyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function (): AnalyserNode {
      const analyser = originalCreateAnalyser.call(this);
      const analyserId = ++nextAnalyserId;
      const originalGetFloatTimeDomainData = analyser.getFloatTimeDomainData.bind(analyser);
      analyserStates.set(analyserId, {
        calls: 0,
        lastRms: 0,
        minRms: Number.POSITIVE_INFINITY,
        maxRms: 0,
        lastAtMs: performance.now(),
      });
      analyser.getFloatTimeDomainData = (samples: Float32Array): void => {
        originalGetFloatTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) {
          sumSquares += sample * sample;
        }
        const rms = samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);
        const state = analyserStates.get(analyserId);
        if (state !== undefined) {
          state.calls += 1;
          state.lastRms = rms;
          state.minRms = Math.min(state.minRms, rms);
          state.maxRms = Math.max(state.maxRms, rms);
          state.lastAtMs = performance.now();
        }
      };
      return analyser;
    };

    const originalSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (
      data: string | Blob | ArrayBuffer | ArrayBufferView,
    ): void {
      let parsedType: string | undefined;
      let eventId: string | undefined;
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data) as {
            type?: unknown;
            event_id?: unknown;
          };
          parsedType = typeof parsed.type === "string" ? parsed.type : undefined;
          eventId = typeof parsed.event_id === "string" ? parsed.event_id : undefined;
        } catch {
          console.log(`${prefix} outbound=<invalid-json>`);
        }
      }

      if (parsedType === "session.input_audio.mute") {
        const requestedAtMs = performance.now();
        console.log(
          `${prefix} mute_delay=${JSON.stringify({
            eventId,
            requestedAtMs,
            delayMs: 1_000,
          })}`,
        );
        window.setTimeout(() => {
          console.log(
            `${prefix} outbound=${JSON.stringify({
              type: parsedType,
              eventId,
              atMs: performance.now(),
            })}`,
          );
          Reflect.apply(originalSend, this, [data]);
        }, 1_000);
        return;
      }

      if (parsedType !== undefined) {
        console.log(
          `${prefix} outbound=${JSON.stringify({
            type: parsedType,
            eventId,
            atMs: performance.now(),
          })}`,
        );
      }
      Reflect.apply(originalSend, this, [data]);
    };

    document.addEventListener("visibilitychange", () => {
      console.log(
        `${prefix} visibility=${JSON.stringify({
          state: document.visibilityState,
          atMs: performance.now(),
        })}`,
      );
    });
    screen.orientation?.addEventListener("change", () => {
      console.log(
        `${prefix} orientation=${JSON.stringify({
          type: screen.orientation.type,
          angle: screen.orientation.angle,
          atMs: performance.now(),
        })}`,
      );
    });

    window.setInterval(() => {
      const analysers = [...analyserStates.entries()].map(([id, state]) => ({
        id,
        calls: state.calls,
        lastRms: state.lastRms,
        minRms: Number.isFinite(state.minRms) ? state.minRms : null,
        maxRms: state.maxRms,
        lastAtMs: state.lastAtMs,
      }));
      console.log(
        `${prefix} sample=${JSON.stringify({
          atMs: performance.now(),
          visibility: document.visibilityState,
          orientation: screen.orientation?.type ?? null,
          analysers,
        })}`,
      );
    }, 5_000);
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    mobile: false,
    width: PORTRAIT_SCREEN.width,
    height: PORTRAIT_SCREEN.height,
    screenWidth: PORTRAIT_SCREEN.width,
    screenHeight: PORTRAIT_SCREEN.height,
    deviceScaleFactor: 1,
    screenOrientation: {
      type: "portraitPrimary",
      angle: 0,
    },
  });
}
