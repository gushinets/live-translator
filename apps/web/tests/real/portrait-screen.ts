import type { Page } from "@playwright/test";

const PORTRAIT_SCREEN = { width: 390, height: 844 };
const STATUS_TRACE_PREFIX = "[real-live-status]";
const ANALYSER_TRACE_PREFIX = "[real-live-analyser]";

export async function emulatePortraitScreen(page: Page): Promise<void> {
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith(STATUS_TRACE_PREFIX) || text.startsWith(ANALYSER_TRACE_PREFIX)) {
      console.log(text);
    }
  });

  await page.addInitScript(() => {
    interface AnalyserStats {
      calls: number;
      lastRms: number;
      maxRms: number;
      aboveActiveFloor: number;
      consecutiveAboveActiveFloor: number;
      maxConsecutiveAboveActiveFloor: number;
      firstAboveAtMs: number | null;
      lastAboveAtMs: number | null;
    }

    const activeFloor = 0.015;
    const analyserStats = new Map<number, AnalyserStats>();
    let nextAnalyserId = 0;
    let traceWindowActive = false;
    let expectedListeningTestId: string | null = null;

    const resetAnalyserStats = (): void => {
      for (const state of analyserStats.values()) {
        state.calls = 0;
        state.lastRms = 0;
        state.maxRms = 0;
        state.aboveActiveFloor = 0;
        state.consecutiveAboveActiveFloor = 0;
        state.maxConsecutiveAboveActiveFloor = 0;
        state.firstAboveAtMs = null;
        state.lastAboveAtMs = null;
      }
    };

    const originalCreateAnalyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function (): AnalyserNode {
      const analyser = originalCreateAnalyser.call(this);
      const analyserId = ++nextAnalyserId;
      const originalGetFloatTimeDomainData = analyser.getFloatTimeDomainData.bind(analyser);
      analyserStats.set(analyserId, {
        calls: 0,
        lastRms: 0,
        maxRms: 0,
        aboveActiveFloor: 0,
        consecutiveAboveActiveFloor: 0,
        maxConsecutiveAboveActiveFloor: 0,
        firstAboveAtMs: null,
        lastAboveAtMs: null,
      });
      analyser.getFloatTimeDomainData = (samples: Float32Array): void => {
        originalGetFloatTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) {
          sumSquares += sample * sample;
        }
        const rms = samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);
        const state = analyserStats.get(analyserId);
        if (state === undefined) {
          return;
        }
        state.calls += 1;
        state.lastRms = rms;
        state.maxRms = Math.max(state.maxRms, rms);
        if (rms >= activeFloor) {
          state.aboveActiveFloor += 1;
          state.consecutiveAboveActiveFloor += 1;
          state.maxConsecutiveAboveActiveFloor = Math.max(
            state.maxConsecutiveAboveActiveFloor,
            state.consecutiveAboveActiveFloor,
          );
          state.firstAboveAtMs ??= performance.now();
          state.lastAboveAtMs = performance.now();
        } else {
          state.consecutiveAboveActiveFloor = 0;
        }
      };
      return analyser;
    };

    const traceStatus = (element: Element): void => {
      const testId = element.getAttribute("data-testid");
      if (testId !== "participant-status-A" && testId !== "participant-status-B") {
        return;
      }
      const text = (element.textContent ?? "").trim();
      if (text === "YOUR TURN") {
        resetAnalyserStats();
        traceWindowActive = true;
        expectedListeningTestId = testId;
      } else if (text === "LISTENING" && testId === expectedListeningTestId) {
        traceWindowActive = false;
        expectedListeningTestId = null;
      }
      console.log(
        `[real-live-status] ${JSON.stringify({
          testId,
          text,
          atMs: performance.now(),
        })}`,
      );
    };

    const observer = new MutationObserver((records) => {
      const visited = new Set<Element>();
      for (const record of records) {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        const status = target?.closest?.(
          '[data-testid="participant-status-A"], [data-testid="participant-status-B"]',
        );
        if (status !== null && status !== undefined && !visited.has(status)) {
          visited.add(status);
          traceStatus(status);
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }
          if (
            node.matches(
              '[data-testid="participant-status-A"], [data-testid="participant-status-B"]',
            )
          ) {
            if (!visited.has(node)) {
              visited.add(node);
              traceStatus(node);
            }
          }
          for (const child of node.querySelectorAll(
            '[data-testid="participant-status-A"], [data-testid="participant-status-B"]',
          )) {
            if (!visited.has(child)) {
              visited.add(child);
              traceStatus(child);
            }
          }
        }
      }
    });

    observer.observe(document, { childList: true, characterData: true, subtree: true });

    window.setInterval(() => {
      if (!traceWindowActive) {
        return;
      }
      const analysers = [...analyserStats.entries()].map(([id, state]) => ({
        id,
        ...state,
      }));
      console.log(
        `[real-live-analyser] ${JSON.stringify({
          atMs: performance.now(),
          expectedListeningTestId,
          analysers,
        })}`,
      );
    }, 1_000);
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
