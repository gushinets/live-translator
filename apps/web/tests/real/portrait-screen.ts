import type { Page } from "@playwright/test";

const PORTRAIT_SCREEN = { width: 390, height: 844 };
const STATUS_TRACE_PREFIX = "[real-live-status]";

export async function emulatePortraitScreen(page: Page): Promise<void> {
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith(STATUS_TRACE_PREFIX)) {
      console.log(text);
    }
  });

  await page.addInitScript(() => {
    const traceStatus = (element: Element): void => {
      const testId = element.getAttribute("data-testid");
      if (testId !== "participant-status-A" && testId !== "participant-status-B") {
        return;
      }
      console.log(
        `[real-live-status] ${JSON.stringify({
          testId,
          text: (element.textContent ?? "").trim(),
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
