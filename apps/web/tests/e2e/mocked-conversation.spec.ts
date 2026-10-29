import { expect, test, type Page } from "@playwright/test";
import { runtime } from "../../src/config/runtime";
import { MockLiveHarness } from "./mockLiveHarness";

// Same-script language changes use complete sentences as evidence.
const COURIER_TURNS: ReadonlyArray<{ original: string; translation: string }> = [
  { original: "Package for apartment 12.", translation: "Paquete para el apartamento 12." },
  { original: "Dejelo en la puerta.", translation: "Leave it at the door." },
  { original: "I need a signature.", translation: "Necesito una firma." },
  { original: "Un momento por favor.", translation: "One moment please." },
  { original: "The code is 4512.", translation: "El codigo es 4512." },
  { original: "Muchas gracias por entregar el paquete.", translation: "Thank you." },
  { original: "Have a good evening.", translation: "Que tenga una buena noche." },
  { original: "Que tenga una buena tarde también.", translation: "Same to you." },
  { original: "The elevator is on the left.", translation: "El ascensor esta a la izquierda." },
  { original: "Perfecto, muchas gracias por su ayuda.", translation: "Perfect, thank you for your help." },
];

test.describe("mocked conversation runtime", () => {
  test("End stays busy until the provider confirms closure", async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await page.evaluate(() => {
      const channel = window.__liveTranslatorTestLive!.channel as EventTarget & { send(data: string): void };
      const send = channel.send.bind(channel);
      channel.send = data => {
        if (JSON.parse(data).type !== "session.close") send(data);
      };
    });
    const end = page.getByRole("button", { name: "End", exact: true });
    await end.click();
    const closing = page.getByRole("button", { name: "Ending…", exact: true });
    await expect(closing).toBeDisabled();
    await expect(closing).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".retained-recovery")).toHaveCount(0);
    await expect(page.getByTestId("participant-pane-A")).toBeVisible();
    await expect(page.getByTestId("participant-pane-B")).toBeVisible();
    await harness.sessionClosed("user_requested", 1);
    await expect(page.getByTestId("participant-status-A")).toHaveText("Conversation ended");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Conversación finalizada");
    await page.getByRole("button", { name: "Back to start", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start translation", exact: true })).toBeEnabled();
    await expect(page.locator(".conversation-screen")).toHaveCount(0);
  });
  test("courier flow alternates A/B, faces each participant and retains every turn", async ({
    page,
  }, testInfo) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    const liveSessionCreatesAfterSetup = harness.liveSessionCreateCount();
    const peerCreatesAfterSetup = await harness.peerCreateCount();
    expect(liveSessionCreatesAfterSetup).toBe(1);
    expect(peerCreatesAfterSetup).toBe(1);

    for (const [index, turn] of COURIER_TURNS.entries()) {
      const speaker = index % 2 === 0 ? "A" : "B";
      const recipient = speaker === "A" ? "B" : "A";
      await completeTextOnlyTurn(harness, page, {
        speaker,
        recipient,
        original: turn.original,
        translation: turn.translation,
      });
      expect(harness.liveSessionCreateCount()).toBe(liveSessionCreatesAfterSetup);
      expect(await harness.peerCreateCount()).toBe(peerCreatesAfterSetup);
    }

    await expect(page.getByTestId("participant-status-A")).toHaveText("You can speak");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Puedes hablar");
    await expect(page.getByTestId("participant-pane-A").locator(".recent-turn")).toHaveCount(
      COURIER_TURNS.length,
    );
    await expect(page.getByTestId("participant-pane-B").locator(".recent-turn")).toHaveCount(
      COURIER_TURNS.length,
    );
    const facing = await page.getByTestId("participant-pane-B").locator(".recent-turn-primary").last().evaluate(element => {
      let orientation = new DOMMatrix();
      for (let node: Element | null = element; node; node = node.parentElement) {
        orientation = new DOMMatrix(getComputedStyle(node).transform).multiply(orientation);
      }
      return {
        horizontal: orientation.a / Math.hypot(orientation.a, orientation.b),
        vertical: orientation.d / Math.hypot(orientation.c, orientation.d),
      };
    });
    expect(facing.horizontal).toBeCloseTo(-1);
    expect(facing.vertical).toBeCloseTo(-1);
    const a = (await page.getByTestId("participant-pane-A").boundingBox())!;
    const b = (await page.getByTestId("participant-pane-B").boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(a.y);
    await expect(page.getByText(COURIER_TURNS[0]!.original)).toHaveCount(1);
    await expect(page.getByText(COURIER_TURNS[6]!.original)).toHaveCount(1);
    await expect(page.getByText(COURIER_TURNS[7]!.original)).toHaveCount(1);
    await expect(page.getByText(COURIER_TURNS[9]!.original)).toHaveCount(1);
    const captions = await page.locator(".recent-turn-primary").allTextContents();
    const scrolls = page.locator(".participant-scroll");
    await scrolls.evaluateAll(elements => elements.forEach(element => {
      element.scrollTop = 120;
      element.dispatchEvent(new Event("scroll"));
    }));
    const positions = await scrolls.evaluateAll(elements => elements.map(element => element.scrollTop));
    await page.getByRole("button", { name: "End", exact: true }).click();
    await expect(page.getByRole("button", { name: "Back to start", exact: true })).toBeVisible();
    expect(await page.locator(".recent-turn-primary").allTextContents()).toEqual(captions);
    expect(await scrolls.evaluateAll(elements => elements.map(element => element.scrollTop))).toEqual(positions);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByTestId("participant-status-A")).toHaveText("Conversation ended");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Conversación finalizada");
    expect(await page.locator(".recent-turn-primary").allTextContents()).toEqual(captions);
    expect(await scrolls.evaluateAll(elements => elements.map(element => element.scrollTop))).toEqual(positions);
    expect(harness.liveSessionCreateCount()).toBe(liveSessionCreatesAfterSetup);
    await page.screenshot({ path: testInfo.outputPath("ended-conversation.png") });
    await page.getByRole("button", { name: "Back to start", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start translation", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Start translation", exact: true }).click();
    await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
    await expect(page.locator(".recent-turn")).toHaveCount(0);
    expect(harness.liveSessionCreateCount()).toBe(liveSessionCreatesAfterSetup + 1);
  });

  test("B starts and A speaks three times without alternating", async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    for (const speaker of ["B", "A", "A", "A", "B"] as const) {
      await completeTextOnlyTurn(harness, page, {
        speaker, recipient: speaker === "A" ? "B" : "A",
        original: speaker === "A" ? "Could you tell me where the train station is?" : "¿Dónde está la estación de tren, por favor?",
        translation: speaker === "A" ? "¿Dónde está la estación de tren, por favor?" : "Could you tell me where the train station is?",
      });
    }
    await harness.sourceActive();
    await harness.inputDelta("OK");
    await expect(page.getByTestId("participant-status-A")).toHaveText("Detecting language");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Detectando idioma");
    await expect(page.locator(".recent-turn-primary").filter({ hasText: "OK" })).toHaveCount(0);
    const english = "Could you tell me where the train station is?";
    const spanish = "¿Dónde está la estación de tren, por favor?";
    const paneA = page.getByTestId("participant-pane-A");
    const paneB = page.getByTestId("participant-pane-B");
    await expect(paneA.locator(".recent-turn-primary")).toHaveText([english, english.repeat(3), english]);
    await expect(paneA.locator(".turn-author")).toHaveText(["Him:", "Me:", "Him:"]);
    // Independent uncertain outputs retain their boundaries instead of joining A1's translation.
    await expect(paneB.locator(".recent-turn-primary")).toHaveText([spanish, spanish, spanish, spanish, spanish]);
    await expect(paneB.locator(".turn-author")).toHaveText(["Yo:", "Él:", "Él:", "Él:", "Yo:"]);
    await harness.sourceQuiet();
  });

  test("early output keeps source LISTENING and does not mute or flip speaker", async ({
    page,
  }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await harness.sourceActive();
    await harness.inputDelta("Where is apartment 12?", 100, 400);
    await expect(page.getByTestId("participant-pane-A").locator(".recent-turn-primary").last()).toHaveText("Where is apartment 12?");
    await expect(page.getByTestId("participant-status-A")).toHaveText("Listening");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Espera");

    await harness.outputDelta("¿Dónde está el apartamento 12?");
    await harness.playbackActive();

    await expect(page.getByTestId("participant-status-A")).toHaveText("Listening");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Escucha la traducción");
    await expect(page.getByTestId("participant-pane-B").locator(".recent-turn-primary").last()).toHaveText(
      "¿Dónde está el apartamento 12?",
    );
    expect(await harness.lastGateBCommand()).toBe("unmute");
    await expect(page.getByTestId("participant-status-B")).not.toHaveText("Puedes hablar");
    await expect(page.getByTestId("participant-status-A")).not.toHaveText("Please wait");

    await harness.sourceQuiet();
    expect(await harness.lastGateBCommand()).toBe("unmute");
    await expect(page.getByTestId("participant-status-A")).toHaveText("Please wait");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Escucha la traducción");
  });

  test("text-only captions close after audio grace without playback", async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await completeTextOnlyTurn(harness, page, {
      speaker: "A",
      recipient: "B",
      original: "Hello from A.",
      translation: "Hola desde A.",
    });
    await expect(page.getByTestId("participant-status-B")).toHaveText("Puedes hablar");
    await expect(page.getByTestId("participant-status-A")).toHaveText("You can speak");
    await expect(page.getByText("Hello from A")).toHaveCount(1);
    await expect(page.getByText("Hola desde A")).toHaveCount(1);
  });

  test("no-output deadline shows an addressed retry prompt until a compatible late result", async ({
    page,
  }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    const steeringBefore = await harness.lastSteeringContent();
    await harness.sourceActive();
    await harness.inputDelta("Hello, where is the nearest train station?");
    await expect(page.getByTestId("participant-pane-A").locator(".recent-turn-primary").last()).toHaveText("Hello, where is the nearest train station?");
    await harness.sourceQuiet();
    expect(await harness.lastGateBCommand()).toBe("unmute");
    await expect(page.getByText("Please repeat")).toHaveCount(0);
    await expect(page.getByTestId("participant-status-B")).toHaveText("Puedes hablar");

    await harness.advance(runtime.noOutputTimeoutMs - 1);
    await expect(page.getByText("Please repeat", { exact: true })).toHaveCount(0);
    await harness.advance(1);
    await expect(page.getByText("Please repeat", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Hello, where is the nearest train station?", { exact: true })).toBeVisible();
    expect(await harness.lastGateBCommand()).toBe("unmute");
    await expect(page.getByTestId("participant-status-A")).toHaveText("You can speak");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Puedes hablar");
    expect(await harness.lastSteeringContent()).toBe(steeringBefore);

    await harness.outputDelta("¿Dónde está la estación de tren, por favor?");
    await expect(page.getByTestId("participant-pane-B").locator(".recent-turn-primary")).toHaveText(
      "¿Dónde está la estación de tren, por favor?",
    );
    await expect(page.getByText("Please repeat", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Hello, where is the nearest train station?", { exact: true })).toHaveCount(1);
    expect(await harness.lastGateBCommand()).toBe("unmute");
  });

  test("two retained source candidates keep unowned output and offer conditional recovery", async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    const original = "Could you tell me where the train station is?";
    const translation = "¿Dónde está la estación de tren, por favor?";
    await completeTextOnlyTurn(harness, page, { speaker: "A", recipient: "B", original, translation });
    // A1 remains a possible continuation; untimed A2 output cannot identify one of the two sources.
    await completeTextOnlyTurn(harness, page, { speaker: "A", recipient: "B", original, translation });
    const paneA = page.getByTestId("participant-pane-A");
    const paneB = page.getByTestId("participant-pane-B");
    await expect(paneA.locator(".recent-turn-primary")).toHaveText(original.repeat(2));
    await expect(paneA.locator(".turn-author")).toHaveText("Me:");
    await expect(paneB.locator(".recent-turn-primary")).toHaveText([translation, translation]);
    await expect(paneB.locator(".turn-author")).toHaveText(["Él:", "Él:"]);
    await expect(page.getByText("If you did not hear a translation, please repeat", { exact: true })).toBeVisible();
    await expect(page.getByText("Please repeat", { exact: true })).toHaveCount(0);
    expect(await harness.lastGateBCommand()).toBe("unmute");
  });
});

async function completeTextOnlyTurn(
  harness: MockLiveHarness,
  page: Page,
  turn: {
    speaker: "A" | "B";
    recipient: "A" | "B";
    original: string;
    translation: string;
  },
): Promise<void> {
  await harness.sourceActive();
  await harness.inputDelta(turn.original);
  await harness.advance(runtime.captionIdleMs);
  await expect(page.getByTestId(`participant-pane-${turn.speaker}`).locator(".recent-turn-primary").last()).toContainText(turn.original);
  await expect(page.getByTestId(`participant-pane-${turn.speaker}`).locator(".turn-author").last()).toHaveText(turn.speaker === "A" ? "Me:" : "Yo:");
  await harness.outputDelta(turn.translation);
  await harness.advance(runtime.captionIdleMs);
  const caption = page.getByTestId(`participant-pane-${turn.recipient}`).locator(".recent-turn-primary").last();
  await expect(caption).toContainText(turn.translation);
  await expect(caption).toBeVisible();
  await expect(caption).toHaveAttribute("lang", turn.recipient === "A" ? "en" : "es");
  const author = caption.locator("..").locator(".turn-author");
  await expect(author).toHaveText(turn.recipient === "A" ? "Him:" : "Él:");
  await expect(page.getByTestId(`participant-status-${turn.speaker}`)).toHaveText(turn.speaker === "A" ? "Listening" : "Escuchando");
  expect(await harness.lastGateBCommand()).not.toBe("mute");
  await harness.sourceQuiet();
  expect(await harness.lastGateBCommand()).toBe("unmute");
  await harness.advance(runtime.noOutputTimeoutMs);
  await expect(page.getByTestId(`participant-status-${turn.recipient}`)).toHaveText(turn.recipient === "A" ? "You can speak" : "Puedes hablar");
  await expect(page.getByTestId(`participant-status-${turn.speaker}`)).toHaveText(turn.speaker === "A" ? "You can speak" : "Puedes hablar");
  await harness.waitForGateBUnmuted();
  await harness.advance(runtime.captionIdleMs);
}

test("first language choice is usable with the keyboard on a phone viewport", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await page.goto("/");
  const german = page.getByRole("radio", { name: "German" });
  await german.focus();
  await page.keyboard.press("Space");
  await expect(german).toBeChecked();
  await page.getByRole("radio", { name: "Spanish" }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("language-choice.png") });
  await page.getByRole("button", { name: "Start translation" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "End" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Partner's language" })).toHaveCount(0);
  await harness.sourceActive();
  await harness.inputDelta("¿Dónde está la estación de tren, por favor?");
  await harness.outputDelta("Where is the train station, please?");
  await expect(page.getByTestId("participant-status-B")).toHaveText("Escuchando");
  await page.screenshot({ path: testInfo.outputPath("conversation-b-first.png") });
});
