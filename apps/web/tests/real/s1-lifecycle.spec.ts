import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { test, expect, type Page, type CDPSession, type TestInfo } from "@playwright/test";
import { cleanupRealSessions } from "./cleanup";
import { installDeterministicMicrophone } from "./microphone";

const deviceSessions = new WeakMap<Page, CDPSession>();

// Real HTTP/SDP/WebRTC/provider. Only delivery of selected browser events is delayed.
type Snapshot = {
  peers: string[]; tracks: Array<{ enabled: boolean; state: string }>;
  sent: string[]; held: string[]; pendingResume: number; hiddenOpenings: number;
  maxTimers: number; wakeLocks: Array<{ released: boolean }>; muted: boolean;
  wakeRequests: number; wakeErrors: string[]; orientationRequests: number; orientationSettled: number;
  visibility: string; orientation: string; width: number; height: number;
};
declare global {
  interface Window {
    __s1: {
      holdEvent: string | null; holdResume: boolean; holdWake: boolean;
      setHidden(hidden: boolean): void; releaseEvents(): void; releaseResume(reject?: boolean): void;
      releaseWake(): void; snapshot(): Snapshot;
    };
  }
}

async function instrument(page: Page) {
  await installDeterministicMicrophone(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
    const tracks = () => window.__liveTranslatorRealMic?.captureTracks() ?? [];
    const peers: RTCPeerConnection[] = [], sent: string[] = [];
    const held: Array<{ channel: RTCDataChannel; data: string; type: string }> = [];
    const resumes: Array<(reject: boolean) => void> = [], wakes: Array<() => void> = [];
    const sentinels: WakeLockSentinel[] = [], maxTimers = new Set<number>();
    const wakeErrors: string[] = [];
    let wakeRequests = 0, orientationRequests = 0, orientationSettled = 0;
    let hidden = false, replaying = false, hiddenOpenings = 0;
    const enabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, "enabled")!;
    Object.defineProperty(MediaStreamTrack.prototype, "enabled", { ...enabled, set(value: boolean) {
      if (value && tracks().includes(this) && document.visibilityState === "hidden") hiddenOpenings++;
      enabled.set!.call(this, value);
    } });
    const createChannel = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      peers.push(this);
      const channel = createChannel.apply(this, args), send = channel.send.bind(channel);
      channel.send = ((data: string) => { sent.push(JSON.parse(data).type); send(data); }) as typeof channel.send;
      channel.addEventListener("message", event => {
        const type = JSON.parse(event.data).type as string;
        if (!replaying && type === window.__s1.holdEvent) {
          held.push({ channel, data: event.data, type }); event.stopImmediatePropagation();
        }
      });
      return channel;
    };
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      const work = resume.call(this);
      if (!window.__s1.holdResume) return work;
      return work.then(() => new Promise<void>((resolve, reject) => {
        resumes.push(fail => fail ? reject(new Error("Delayed native resume rejected")) : resolve());
      }));
    };
    if (navigator.wakeLock) {
      const request = navigator.wakeLock.request.bind(navigator.wakeLock);
      navigator.wakeLock.request = async type => {
        wakeRequests++;
        const sentinel = await request(type).catch(error => { wakeErrors.push(`${error.name}: ${error.message}`); throw error; });
        sentinels.push(sentinel);
        if (window.__s1.holdWake) await new Promise<void>(resolve => wakes.push(resolve));
        return sentinel;
      };
    }
    const orientation = screen.orientation as ScreenOrientation & { lock?: (type: string) => Promise<void> };
    if (orientation.lock) {
      const lock = orientation.lock.bind(orientation);
      orientation.lock = async type => {
        orientationRequests++;
        try { await lock(type); } finally { orientationSettled++; }
      };
    }
    const setTimer = window.setTimeout.bind(window), clearTimer = window.clearTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id = setTimer(handler, ms, ...args); if (ms === 900000) maxTimers.add(id); return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = id => { if (id !== undefined) maxTimers.delete(id); clearTimer(id); };
    window.__s1 = {
      holdEvent: null, holdResume: false, holdWake: false,
      setHidden(value) {
        hidden = value;
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event("visibilitychange"));
      },
      releaseEvents() {
        this.holdEvent = null; replaying = true;
        for (const event of held.splice(0)) event.channel.dispatchEvent(new MessageEvent("message", { data: event.data }));
        replaying = false;
      },
      releaseResume(fail = false) { this.holdResume = false; for (const release of resumes.splice(0)) release(fail); },
      releaseWake() { this.holdWake = false; for (const release of wakes.splice(0)) release(); },
      snapshot: () => ({ peers: peers.map(peer => peer.connectionState),
        tracks: tracks().map(track => ({ enabled: track.enabled, state: track.readyState })),
        sent: [...sent], held: held.map(event => event.type), pendingResume: resumes.length, hiddenOpenings,
        maxTimers: maxTimers.size, wakeLocks: sentinels.map(sentinel => ({ released: sentinel.released })),
        wakeRequests, wakeErrors: [...wakeErrors], orientationRequests, orientationSettled,
        visibility: document.visibilityState, orientation: screen.orientation.type, width: innerWidth, height: innerHeight,
        muted: document.querySelector("audio")?.muted ?? true }),
    };
  });
  await orient(page, true);
}
const snapshot = (page: Page) => page.evaluate(() => window.__s1.snapshot());
async function orient(page: Page, portrait: boolean) {
  let cdp = deviceSessions.get(page);
  if (!cdp) { cdp = await page.context().newCDPSession(page); deviceSessions.set(page, cdp); }
  await cdp.send("Emulation.setDeviceMetricsOverride", { mobile: false,
    width: portrait ? 390 : 844, height: portrait ? 844 : 390,
    screenWidth: portrait ? 390 : 844, screenHeight: portrait ? 844 : 390, deviceScaleFactor: 1,
    screenOrientation: { type: portrait ? "portraitPrimary" : "landscapePrimary", angle: portrait ? 0 : 90 } });
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  // Playwright's screenshot viewport restore clears our CDP screen orientation.
  const { data } = await deviceSessions.get(page)!.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(info.outputPath(name), Buffer.from(data, "base64"));
}
async function start(page: Page) {
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByTestId("participant-status-A")).toHaveText("Можно говорить");
}
async function stopped(page: Page) {
  await expect.poll(async () => {
    const value = await snapshot(page);
    return value.peers.length > 0 && value.tracks.length > 0 && value.peers.every(state => state === "closed") && value.tracks.every(track => track.state === "ended") && value.muted;
  }).toBe(true);
}

test.describe("S1 real provider lifecycle", () => {
  const attempts = new Map<string, string>();
  test.beforeEach(async ({ page, baseURL }) => {
    attempts.clear();
    await page.context().grantPermissions(["screen-wake-lock"], { origin: baseURL! });
    page.on("response", async response => {
      if (new URL(response.url()).pathname !== "/api/live/session" || response.request().method() !== "POST" || response.status() === 201) return;
      const body = await response.json().catch(() => ({}));
      console.log(`[s1-create-failure] ${JSON.stringify({ status: response.status(), code: body.code, error: typeof body.error === "string" ? body.error : undefined })}`);
    });
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/live/session" && request.method() === "POST") {
        const body = request.postDataJSON(); attempts.set(body.liveSessionId, body.conversationId);
      }
    });
    await instrument(page); await page.goto("/");
  });
  test.afterEach(async ({ page, baseURL }, info) => {
    test.setTimeout(60000);
    try {
      writeFileSync(info.outputPath("browser-state.json"), JSON.stringify(await snapshot(page), null, 2));
      writeFileSync(info.outputPath("provider-events.json"), JSON.stringify(await page.evaluate(() => window.__liveTranslatorRealDiagnostics?.events ?? []), null, 2));
      await screenshot(page, info, "result.png");
    } finally { await cleanupRealSessions(page.request, baseURL!, attempts); }
    for (const id of attempts.keys()) {
      const response = await page.request.get(`/api/live/session/${id}`);
      const { state, closeConfirmed, providerFinalSeconds, providerFinalSource } = await response.json();
      console.log(`[s1-live-cleanup] ${JSON.stringify({ state, closeConfirmed, providerFinalSeconds, providerFinalSource })}`);
    }
  });
  async function closedByApp(page: Page) {
    expect(attempts.size).toBeGreaterThan(0);
    for (const id of attempts.keys()) {
      await expect.poll(() => page.evaluate(async attempt => {
        const value = await (await fetch(`/api/live/session/${attempt}`)).json();
        return value.state === "closed" && value.closeConfirmed === true;
      }, id), { timeout: 35000 }).toBe(true);
    }
  }

  test("F01/F16 closes the real provider after initial mute ACK timeout, ignores late ACK", async ({ page }) => {
    await page.evaluate(() => { window.__s1.holdEvent = "session.input_audio.muted"; });
    await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).held.length).toBeGreaterThan(0);
    await expect(page.getByRole("alert").first()).toContainText("Не удалось запустить перевод");
    await stopped(page); await closedByApp(page);
    await page.evaluate(() => window.__s1.releaseEvents());
    await expect(page.getByRole("alert").first()).toContainText("Не удалось запустить перевод");
    expect((await snapshot(page)).maxTimers).toBe(0);
    expect((await snapshot(page)).sent.filter(type => type === "session.close")).toHaveLength(1);
  });

  test("F02 hidden at the final unmute ACK never opens capture", async ({ page }) => {
    await page.evaluate(() => { window.__s1.holdEvent = "session.input_audio.unmuted"; });
    await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).held.length).toBeGreaterThan(0);
    expect((await snapshot(page)).tracks.length).toBeGreaterThan(0);
    await page.evaluate(() => { window.__s1.setHidden(true); window.__s1.releaseEvents(); });
    await expect.poll(async () => (await snapshot(page)).tracks.every(track => !track.enabled || track.state === "ended")).toBe(true);
    expect((await snapshot(page)).hiddenOpenings).toBe(0);
    if (process.env.REAL_LIVE_BACKGROUND_CLOSE === "false") {
      await expect(page.getByTestId("participant-status-A")).toHaveText("Пауза");
      await page.evaluate(() => window.__s1.setHidden(false));
      await expect(page.getByTestId("participant-status-A")).toHaveText("Можно говорить");
      await page.getByRole("button", { name: "Завершить", exact: true }).click();
    } else {
      await stopped(page); await closedByApp(page);
      await page.getByRole("button", { name: "Завершить сохранённый разговор" }).click();
    }
    await stopped(page); await closedByApp(page);
  });

  test("F07 missing session.started times out and late started cannot reactivate", async ({ page }) => {
    await page.evaluate(() => { window.__s1.holdEvent = "session.started"; });
    await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).held.length).toBeGreaterThan(0);
    await expect(page.getByRole("alert").first()).toContainText("Не удалось запустить перевод", { timeout: 20000 });
    await stopped(page); await closedByApp(page);
    await page.evaluate(() => window.__s1.releaseEvents());
    await stopped(page);
    expect(attempts.size).toBe(1);
  });

  test("F07 retained resume preserves close proof after missing session.started", async ({ page }) => {
    test.skip(process.env.REAL_LIVE_BACKGROUND_CLOSE === "false", "Retained recovery requires its enabled policy");
    await start(page);
    await page.evaluate(() => window.__s1.setHidden(true));
    await stopped(page); await closedByApp(page);
    await page.evaluate(() => { window.__s1.holdEvent = "session.started"; window.__s1.setHidden(false); });
    await expect.poll(async () => (await snapshot(page)).held.length).toBeGreaterThan(0);
    await expect(page.getByText(/^Не удалось восстановить разговор\./)).toBeVisible({ timeout: 30000 });
    expect(attempts.size).toBe(2);
    await stopped(page); await closedByApp(page);
    await page.evaluate(() => window.__s1.releaseEvents());
    await stopped(page);
    await page.getByRole("button", { name: "Завершить сохранённый разговор" }).click();
    await expect(page.getByRole("button", { name: "На начальный экран", exact: true })).toBeVisible();
  });

  test("F07 sideband closes the real provider on browser cleanup request", async ({ page }) => {
    await start(page);
    // Keep transport alive so abrupt peer destruction cannot erase provider close proof.
    await page.evaluate(() => { window.__s1.holdEvent = "session.closed"; });
    for (const id of attempts.keys()) {
      expect(await page.evaluate(async attempt => (await fetch(`/api/live/session/${attempt}/cleanup`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "user_end" }),
      })).status, id)).toBe(200);
    }
    await closedByApp(page);
    expect((await snapshot(page)).sent).not.toContain("session.close");
    for (const id of attempts.keys()) {
      const response = await page.request.get(`/api/live/session/${id}`);
      expect((await response.json()).providerFinalSource).toBe("sideband");
    }
    await page.evaluate(() => window.__s1.releaseEvents());
    await stopped(page);
  });

  test("F15/F16 landscape End is keyboard reachable with real provider and delayed wake result", async ({ page }, info) => {
    await page.evaluate(() => { window.__s1.holdWake = true; });
    await start(page);
    await expect.poll(async () => (await snapshot(page)).wakeLocks.length).toBeGreaterThan(0);
    await orient(page, false);
    const end = page.getByRole("dialog").getByRole("button", { name: "Завершить", exact: true });
    await expect(end).toBeFocused(); await page.keyboard.press("Tab"); await expect(end).toBeFocused();
    await screenshot(page, info, "rotation-dialog.png");
    await page.keyboard.press("Enter");
    await stopped(page); await closedByApp(page);
    await page.evaluate(() => window.__s1.releaseWake());
    await expect.poll(async () => (await snapshot(page)).wakeLocks.every(lock => lock.released)).toBe(true);
    expect((await snapshot(page)).maxTimers).toBe(0);
  });

  test("F25 lifecycle audio timeout retires provider and preserves the error", async ({ page }) => {
    await start(page); await orient(page, false);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate(() => { window.__s1.holdResume = true; });
    await orient(page, true);
    await expect.poll(async () => (await snapshot(page)).pendingResume).toBeGreaterThan(0);
    await expect(page.getByRole("alert").first()).toContainText("Соединение прервано", { timeout: 15000 });
    await stopped(page); await closedByApp(page);
    await page.evaluate(() => window.__s1.releaseResume());
    await expect(page.getByRole("alert").first()).toContainText("Соединение прервано");
  });

  test("F25 retained End interrupts pending native resume before its deadline", async ({ page }, info) => {
    test.skip(process.env.REAL_LIVE_BACKGROUND_CLOSE === "false", "Retained recovery requires its enabled policy");
    await start(page);
    await page.evaluate(() => window.__s1.setHidden(true));
    await stopped(page); await closedByApp(page);
    await page.evaluate(() => { window.__s1.holdResume = true; window.__s1.setHidden(false); });
    await expect.poll(async () => (await snapshot(page)).pendingResume).toBeGreaterThan(0);
    const end = page.getByRole("button", { name: "Завершить сохранённый разговор" });
    await expect(end).toBeEnabled();
    await screenshot(page, info, "retained-resuming.png");
    await end.click();
    await expect(page.getByRole("button", { name: "На начальный экран", exact: true })).toBeVisible({ timeout: 5000 });
    await stopped(page);
    expect(attempts.size).toBe(1);
    await page.evaluate(() => window.__s1.releaseResume(true));
    await page.getByRole("button", { name: "На начальный экран", exact: true }).click();
    await start(page);
    expect(attempts.size).toBe(2);
    await page.getByRole("button", { name: "Завершить", exact: true }).click();
    await stopped(page); await closedByApp(page);
  });

  test("F15 MAX_SOURCE cannot manually reopen capture in landscape", async ({ page }) => {
    // Shorten only the product's 30s source limit; transport/ACK/media clocks remain real.
    await page.evaluate(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) =>
        original(callback, ms === 30000 ? 1000 : ms, ...args)) as typeof window.setTimeout;
    });
    await start(page);
    const speech = readFileSync(new URL("./fixtures/participant-a.mp3.b64", import.meta.url), "utf8").trim();
    await page.evaluate(async value => { await window.__liveTranslatorRealMic!.startBase64Audio(value); }, speech);
    const resume = page.getByRole("button", { name: "Продолжить / повторить" });
    await expect(resume).toBeVisible();
    await orient(page, false);
    const before = (await snapshot(page)).sent.filter(type => type === "session.input_audio.unmute").length;
    await resume.click();
    expect((await snapshot(page)).tracks.every(track => !track.enabled || track.state === "ended")).toBe(true);
    expect((await snapshot(page)).sent.filter(type => type === "session.input_audio.unmute")).toHaveLength(before);
    await orient(page, true); await resume.click();
    await expect(page.getByTestId("participant-status-A")).toHaveText("Можно говорить");
    await page.getByRole("button", { name: "Завершить", exact: true }).click();
    await stopped(page); await closedByApp(page);
  });
});
