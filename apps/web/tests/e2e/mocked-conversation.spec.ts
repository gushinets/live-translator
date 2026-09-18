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
  { original: "Gracias", translation: "Thank you" },
  { original: "Have a good evening", translation: "Que tenga una buena noche" },
  { original: "Igualmente", translation: "Same to you" },
  { original: "The elevator is on the left", translation: "El ascensor esta a la izquierda" },
  { original: "Perfecto", translation: "Perfect" },
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
      expect(harness.liveSessionCreateCount()).toBe(1);
      expect(await harness.peerCreateCount()).toBe(1);
    }

    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");
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
    expect(await harness.lastGateBCommand()).toBeUndefined();
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
    await expect(page.getByTestId("participant-status-A")).toHaveText("ОЖИДАНИЕ");
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
    await harness.inputDelta("Hello");
    await expect(page.getByTestId("current-primary-A")).toHaveText("Hello");
    await harness.sourceQuiet();
    await expect.poll(async () => harness.lastGateBCommand()).toBe("mute");
    await expect(page.getByText("Повторите")).toHaveCount(0);
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");

    await harness.advance(runtime.noOutputTimeoutMs);
    await expect(page.getByText("Повторите")).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");
    expect(await harness.lastSteeringContent()).toBe(steeringBefore);
  });

  test("correction suppresses Gate C, rejects stale output, and steers the corrected side", async ({
    page,
  }) => {
    const harness = await MockLiveHarness.attach(page);
    await harness.startListeningConversation();
    await harness.sourceActive();
    await harness.inputDelta("Hello");
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
    await expect(page.getByTestId("current-primary-B")).toHaveText("Hello");
    await expect(page.getByText("stale-wrong-side")).toHaveCount(0);
    await expect.poll(async () => harness.isOutputMuted()).toBe(true);

    await harness.advance(runtime.captionIdleMs);
    await harness.outputDelta("Hello there");
    await expect(page.getByTestId("current-primary-A")).toHaveText("Hello there");
    await expect(page.getByTestId("current-primary-B")).toHaveText("Hello");
    await expect.poll(async () => harness.isOutputMuted()).toBe(false);

    await harness.sourceQuiet();
    await harness.advance(runtime.audioStartGraceMs);
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");
    const steering = await harness.lastSteeringContent();
    expect(steering).toContain("The next expected source speaker is Participant A.");
    expect(steering).toContain("Interpret their speech for Participant B.");
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
  await expect(page.getByTestId(`participant-status-${turn.speaker}`)).toHaveText("ОЖИДАНИЕ");
  await harness.waitForGateBUnmuted();
  await harness.advance(runtime.captionIdleMs);
}
