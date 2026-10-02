import { expect, test, type Page } from "@playwright/test";
import { runtime } from "../../src/config/runtime";
import { MAX_RECENT_TURNS } from "../../src/conversation/TurnBuffer";
import { MockLiveHarness } from "./mockLiveHarness";

const COURIER_TURNS: ReadonlyArray<{ original: string; translation: string }> = [
  { original: "Package for apartment 12", translation: "Paquete para el apartamento 12" },
  { original: "Dejelo en la puerta", translation: "Leave it at the door" },
  { original: "I need a signature", translation: "Necesito una firma" },
  { original: "Un momento por favor", translation: "One moment please" },
  { original: "The code is 4512", translation: "El codigo es 4512" },
  { original: "Muchas gracias por entregar el paquete", translation: "Thank you" },
  { original: "Have a good evening", translation: "Que tenga una buena noche" },
  { original: "Que tenga una buena tarde también", translation: "Same to you" },
  { original: "The elevator is on the left", translation: "El ascensor esta a la izquierda" },
  { original: "Perfecto, muchas gracias por su ayuda", translation: "Perfect" },
];

test.describe("mocked conversation runtime", () => {
  test("preserves old captions after changing B's language and labels new translations relative to each pane", async ({ page }, testInfo) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await completeTextOnlyTurn(harness, page, {
      speaker: "A", recipient: "B", original: "Where is the train station, please?",
      translation: "¿Dónde está la estación de tren, por favor?",
    });
    await page.getByRole("button", { name: "Partner's language" }).click();
    await page.getByRole("radio", { name: "German" }).check();
    await page.getByRole("button", { name: "Confirm" }).click();
    const b = page.getByTestId("participant-pane-B");
    await expect(b).toHaveAttribute("lang", "de");
    await expect(b.locator(".recent-turn")).toHaveText("Er: ¿Dónde está la estación de tren, por favor?");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Sprechen Sie");
    await harness.sourceActive();
    await harness.inputDelta("Could you tell me how to get there?");
    await expect(page.getByTestId("current-primary-B")).toHaveCount(0);
    await harness.outputDelta("Könnten Sie mir sagen, wie ich dorthin komme?");
    await expect(page.getByTestId("current-author-A")).toHaveText("Me:");
    await expect(page.getByTestId("current-author-B")).toHaveText("Er:");
    await expect(page.getByTestId("current-primary-B")).toHaveText("Könnten Sie mir sagen, wie ich dorthin komme?");
    await expect(page.getByTestId("participant-pane-A").locator(".recent-turn")).toHaveText("Me: Where is the train station, please?");
    await expect(page.locator(".current-secondary, .recent-turn-secondary")).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(page.getByTestId("current-author-A")).toBeVisible();
    await expect(page.getByTestId("current-author-B")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("localized-conversation.png") });
  });

  test("reopening languages reflects the queued choice before the turn ends", async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await harness.sourceActive();
    await harness.inputDelta("Could you tell me where the train station is?");
    await page.getByRole("button", { name: "Partner's language" }).click();
    await page.getByRole("radio", { name: "German" }).check();
    await page.getByRole("button", { name: "Confirm" }).click();
    await page.getByRole("button", { name: "Partner's language" }).click();
    await expect(page.getByRole("radio", { name: "German" })).toBeChecked();
    await page.getByRole("button", { name: "Confirm" }).click();
    await harness.outputDelta("Wo ist der Bahnhof?");
    await harness.sourceQuiet();
    await harness.advance(runtime.audioStartGraceMs);
    await expect(page.getByText("B · Deutsch")).toBeVisible();
  });
  test("End keeps the toolbar geometry until the provider confirms closure", async ({ page }) => {
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
    const buttonBefore = await end.boundingBox();
    const toolbarBefore = await page.locator(".conversation-center").boundingBox();
    await end.click();
    const closing = page.getByRole("button", { name: "Ending…", exact: true });
    await expect(closing).toBeDisabled();
    await expect(closing).toHaveAttribute("aria-busy", "true");
    expect(await closing.boundingBox()).toEqual(buttonBefore);
    expect(await page.locator(".conversation-center").boundingBox()).toEqual(toolbarBefore);
    await expect(page.locator(".retained-recovery")).toHaveCount(0);
    await expect(page.getByTestId("participant-pane-A")).toBeVisible();
    await expect(page.getByTestId("participant-pane-B")).toBeVisible();
    await harness.sessionClosed("user_requested", 1);
    await expect(page.getByRole("button", { name: "Start translation", exact: true })).toBeEnabled();
    await expect(page.locator(".conversation-screen")).toHaveCount(0);
  });
  test("courier flow alternates A/B, keeps B rotated, and caps recent turns", async ({
    page,
  }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await expect(page.getByTestId("participant-pane-B")).toHaveAttribute(
      "style",
      /rotate\(180deg\)/,
    );
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
      await expect(page.getByTestId("participant-pane-B")).toHaveAttribute(
        "style",
        /rotate\(180deg\)/,
      );
      expect(harness.liveSessionCreateCount()).toBe(liveSessionCreatesAfterSetup);
      expect(await harness.peerCreateCount()).toBe(peerCreatesAfterSetup);
    }

    await expect(page.getByTestId("participant-status-A")).toHaveText("Speak");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Habla");
    await expect(page.getByTestId("participant-pane-A").locator(".recent-turn")).toHaveCount(
      MAX_RECENT_TURNS,
    );
    await expect(page.getByTestId("participant-pane-B").locator(".recent-turn")).toHaveCount(
      MAX_RECENT_TURNS,
    );
    await expect(page.getByText(COURIER_TURNS[0]!.original)).toHaveCount(0);
    await expect(page.getByText(COURIER_TURNS[6]!.original)).toHaveCount(0);
    await expect(page.getByText(COURIER_TURNS[7]!.original)).toHaveCount(1);
    await expect(page.getByText(COURIER_TURNS[9]!.original)).toHaveCount(1);
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
    await expect(page.locator("[data-testid^='current-primary-'], [data-testid^='current-author-']")).toHaveCount(0);
    await harness.sourceQuiet();
  });

  test("early output keeps source LISTENING and does not mute or flip speaker", async ({
    page,
  }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await harness.sourceActive();
    await harness.inputDelta("Where is apartment 12?", 100, 400);
    await expect(page.getByTestId("current-primary-A")).toHaveText("Where is apartment 12?");
    await expect(page.getByTestId("participant-status-A")).toHaveText("Listening");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Esperando");

    await harness.outputDelta("¿Dónde está el apartamento 12?");
    await harness.playbackActive();

    await expect(page.getByTestId("participant-status-A")).toHaveText("Listening");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Traducción");
    await expect(page.getByTestId("current-primary-B")).toHaveText(
      "¿Dónde está el apartamento 12?",
    );
    expect(await harness.lastGateBCommand()).toBe("unmute");
    await expect(page.getByTestId("participant-status-B")).not.toHaveText("Habla");
    await expect(page.getByTestId("participant-status-A")).not.toHaveText("Waiting");

    await harness.sourceQuiet();
    await expect.poll(async () => harness.lastGateBCommand()).toBe("mute");
    await expect(page.getByTestId("participant-status-A")).toHaveText("Waiting");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Traducción");
  });

  test("text-only captions close after audio grace without playback", async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await completeTextOnlyTurn(harness, page, {
      speaker: "A",
      recipient: "B",
      original: "Hello from A",
      translation: "Hola desde A",
    });
    await expect(page.getByTestId("participant-status-B")).toHaveText("Habla");
    await expect(page.getByTestId("participant-status-A")).toHaveText("Speak");
    await expect(page.getByText("Hello from A")).toHaveCount(1);
    await expect(page.getByText("Hola desde A")).toHaveCount(1);
  });

  test("no-output timeout retries the same speaker instead of the opposite", async ({
    page,
  }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    const steeringBefore = await harness.lastSteeringContent();
    await harness.sourceActive();
    await harness.inputDelta("Hello, where is the nearest train station?");
    await expect(page.getByTestId("current-primary-A")).toHaveText("Hello, where is the nearest train station?");
    await harness.sourceQuiet();
    await expect.poll(async () => harness.lastGateBCommand()).toBe("mute");
    await expect(page.getByText("Please repeat")).toHaveCount(0);
    await expect(page.getByTestId("participant-status-B")).toHaveText("Esperando");

    await harness.advance(runtime.noOutputTimeoutMs);
    await expect(page.getByText("Please repeat")).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("Speak");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Habla");
    expect(await harness.lastSteeringContent()).toBe(steeringBefore);
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
  await expect(page.getByTestId(`current-primary-${turn.speaker}`)).toHaveText(turn.original);
  await expect(page.getByTestId(`current-author-${turn.speaker}`)).toHaveText(turn.speaker === "A" ? "Me:" : "Yo:");
  await harness.outputDelta(turn.translation);
  await expect(page.getByTestId(`current-primary-${turn.recipient}`)).toHaveText(
    turn.translation,
  );
  await expect(page.getByTestId(`current-author-${turn.recipient}`)).toHaveText(turn.recipient === "A" ? "Him:" : "Él:");
  await expect(page.getByTestId(`participant-status-${turn.speaker}`)).toHaveText(turn.speaker === "A" ? "Listening" : "Escuchando");
  expect(await harness.lastGateBCommand()).not.toBe("mute");
  await harness.sourceQuiet();
  await expect.poll(async () => harness.lastGateBCommand()).toBe("mute");
  await harness.advance(runtime.audioStartGraceMs);
  await expect(page.getByTestId(`participant-status-${turn.recipient}`)).toHaveText(turn.recipient === "A" ? "Speak" : "Habla");
  await expect(page.getByTestId(`participant-status-${turn.speaker}`)).toHaveText(turn.speaker === "A" ? "Speak" : "Habla");
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
  await page.getByRole("button", { name: "Partner's language" }).click();
  await expect(page.getByText("Live Translator")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await harness.sourceActive();
  await harness.inputDelta("¿Dónde está la estación de tren, por favor?");
  await harness.outputDelta("Where is the train station, please?");
  await expect(page.getByTestId("participant-status-B")).toHaveText("Escuchando");
  await page.screenshot({ path: testInfo.outputPath("conversation-b-first.png") });
});
