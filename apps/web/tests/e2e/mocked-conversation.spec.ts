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
    expect(liveSessionCreatesAfterSetup).toBe(2);
    expect(peerCreatesAfterSetup).toBe(2);

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

    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-pane-A").locator(".recent-turn")).toHaveCount(
      MAX_RECENT_TURNS,
    );
    await expect(page.getByTestId("participant-pane-B").locator(".recent-turn")).toHaveCount(
      MAX_RECENT_TURNS,
    );
    await expect(page.getByText(COURIER_TURNS[0]!.original)).toHaveCount(0);
    await expect(page.getByText(COURIER_TURNS[6]!.original)).toHaveCount(0);
    await expect(page.getByText(COURIER_TURNS[7]!.original)).toHaveCount(2);
    await expect(page.getByText(COURIER_TURNS[9]!.original)).toHaveCount(2);
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
    await expect(page.getByText("Сторона не определена. Для исправления нажмите свою половину экрана.")).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("ОПРЕДЕЛЯЮ ЯЗЫК");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОПРЕДЕЛЯЮ ЯЗЫК");
    await harness.sourceQuiet();
    await page.getByRole("button", { name: "Исправить: говорил участник B" }).click();
    await expect(page.getByTestId("current-primary-B")).toHaveText("OK");
    await harness.advance(runtime.captionIdleMs);
    await harness.outputDelta("All right");
    await expect(page.getByTestId("current-primary-A")).toHaveText("All right");
    await harness.advance(runtime.audioStartGraceMs);
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
  });

  test("early output keeps source LISTENING and does not mute or flip speaker", async ({
    page,
  }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await harness.sourceActive();
    await harness.inputDelta("Where is apartment 12?", 100, 400);
    await expect(page.getByTestId("current-primary-A")).toHaveText("Where is apartment 12?");
    await expect(page.getByTestId("participant-status-A")).toHaveText("СЛУШАЮ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");

    await harness.outputDelta("¿Dónde está el apartamento 12?");
    await harness.playbackActive();

    await expect(page.getByTestId("participant-status-A")).toHaveText("СЛУШАЮ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ПЕРЕВОД");
    await expect(page.getByTestId("current-primary-B")).toHaveText(
      "¿Dónde está el apartamento 12?",
    );
    expect(await harness.lastGateBCommand()).toBe("unmute");
    await expect(page.getByTestId("participant-status-B")).not.toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-A")).not.toHaveText("ОЖИДАНИЕ");

    await harness.sourceQuiet();
    await expect.poll(async () => harness.lastGateBCommand()).toBe("mute");
    await expect(page.getByTestId("participant-status-A")).toHaveText("ОЖИДАНИЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ПЕРЕВОД");
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
    await expect(page.getByTestId("participant-status-B")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByText("Hello from A")).toHaveCount(2);
    await expect(page.getByText("Hola desde A")).toHaveCount(2);
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
    await expect(page.getByText("Повторите")).toHaveCount(0);
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");

    await harness.advance(runtime.noOutputTimeoutMs);
    await expect(page.getByText("Повторите")).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ГОВОРИТЕ");
    expect(await harness.lastSteeringContent()).toBe(steeringBefore);
  });

  test("correction suppresses Gate C, rejects stale output, and steers the corrected side", async ({
    page,
  }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await harness.sourceActive();
    await harness.inputDelta("Hello, where is the nearest train station?");
    await harness.outputDelta("Hola");
    await harness.playbackActive();
    await expect(page.getByTestId("participant-status-A")).toHaveText("СЛУШАЮ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ПЕРЕВОД");
    await expect.poll(async () => harness.isOutputMuted()).toBe(false);

    await page.getByRole("button", { name: "Исправить: говорил участник B" }).click();
    await expect(page.getByTestId("participant-status-A")).toHaveText("ИСПРАВЛЯЮ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ИСПРАВЛЯЮ");
    await expect.poll(async () => harness.isOutputMuted()).toBe(true);

    await harness.outputDelta("stale-wrong-side");
    await expect(page.getByText("stale-wrong-side")).toHaveCount(0);
    await expect(page.getByTestId("current-primary-B")).toHaveText("Hola");

    await harness.playbackIdle();
    await expect(page.getByTestId("participant-status-A")).not.toHaveText("ИСПРАВЛЯЮ");
    await expect(page.getByTestId("current-primary-B")).toHaveText("Hello, where is the nearest train station?");
    await expect(page.getByText("stale-wrong-side")).toHaveCount(0);
    await expect.poll(async () => harness.isOutputMuted()).toBe(true);

    await harness.advance(runtime.captionIdleMs);
    await harness.outputDelta("Hello there");
    await expect(page.getByTestId("current-primary-A")).toHaveText("Hello there");
    await expect(page.getByTestId("current-primary-B")).toHaveText("Hello, where is the nearest train station?");
    await expect.poll(async () => harness.isOutputMuted()).toBe(false);

    await harness.sourceQuiet();
    await harness.advance(runtime.audioStartGraceMs);
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ГОВОРИТЕ");
    const steering = await harness.lastSteeringContent();
    expect(steering).toContain("Participant A speaks English (en)");
    expect(steering).toContain("never by turn order");
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
  await harness.outputDelta(turn.translation);
  await expect(page.getByTestId(`current-primary-${turn.recipient}`)).toHaveText(
    turn.translation,
  );
  await expect(page.getByTestId(`participant-status-${turn.speaker}`)).toHaveText("СЛУШАЮ");
  expect(await harness.lastGateBCommand()).not.toBe("mute");
  await harness.sourceQuiet();
  await expect.poll(async () => harness.lastGateBCommand()).toBe("mute");
  await harness.advance(runtime.audioStartGraceMs);
  await expect(page.getByTestId(`participant-status-${turn.recipient}`)).toHaveText("ГОВОРИТЕ");
  await expect(page.getByTestId(`participant-status-${turn.speaker}`)).toHaveText("ГОВОРИТЕ");
  await harness.waitForGateBUnmuted();
  await harness.advance(runtime.captionIdleMs);
}

test("calibration validates samples and is usable with the keyboard on a phone viewport", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод" }).click();
  const save = page.getByRole("button", { name: "Сохранить образец" });
  await expect(save).toBeDisabled();
  await harness.inputDelta("OK");
  await save.click();
  await expect(page.getByRole("alert")).toContainText("полное предложение");
  await page.getByRole("button", { name: "Записать заново" }).click();
  await expect(page.getByText("Слушаю участника A")).toBeVisible();
  await harness.inputDelta("Я говорю по-русски и хочу узнать дорогу к вокзалу.");
  await expect(save).toBeEnabled();
  await save.focus();
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await harness.advance(50);
  await expect(page.getByText("Участник A — русский")).toBeVisible();
  await page.getByRole("button", { name: "Записать образец B" }).click();
  await expect(page.getByText("Слушаю участника B")).toBeVisible();
  await harness.inputDelta("Я снова говорю по-русски и хочу узнать дорогу к вокзалу.");
  await save.click();
  await expect(page.getByRole("alert")).toContainText("тот же язык");
  await page.getByRole("button", { name: "Записать заново" }).click();
  await expect(page.getByText("Слушаю участника B")).toBeVisible();
  await harness.inputDelta("I speak English and would like to find the nearest station.");
  await save.click();
  await expect(page.getByText("Участник B — английский")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("languages-ready.png") });
  await page.getByRole("button", { name: "Начать разговор" }).focus();
  await page.keyboard.press("Enter");
  await harness.advance(50);
  await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
  await harness.sourceActive();
  await harness.inputDelta("Could you tell me where the train station is?");
  await harness.outputDelta("Подскажите, пожалуйста, где находится вокзал?");
  await expect(page.getByTestId("participant-status-B")).toHaveText("СЛУШАЮ");
  await page.screenshot({ path: testInfo.outputPath("conversation-b-first.png") });
});
