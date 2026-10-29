import { expect, test } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";
import cases from "../../src/conversation/fixtures/live-ru-es-captions.json" with { type: "json" };

for (const record of cases) test(`saved RU-ES text and labels: ${record.name}`, async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "es");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  const events = [...record.input.map(part => ({ ...part, kind: "input" as const })),
    ...record.outputs.flatMap(output => output.fragments.map(part => ({ ...part, kind: "output" as const }))),
    ...record.voice.map(edge => ({ ...edge, kind: "voice" as const }))]
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  let receivedAt = events[0]!.receivedAtMs;
  for (const part of events) {
    await harness.advance(part.receivedAtMs - receivedAt);
    receivedAt = part.receivedAtMs;
    if (part.kind === "voice") {
      if (part.active) await harness.sourceActive();
      else await harness.sourceQuiet();
    } else if (part.kind === "input") await harness.inputDelta(part.text, part.startMs, part.endMs);
    else await harness.outputDelta(part.text, part.startMs, part.endMs);
  }
  await harness.sourceQuiet();
  await harness.advance(6000);
  const check = async () => {
    for (const side of ["A", "B"] as const) {
      const pane = page.getByTestId(`participant-pane-${side}`);
      const own = side === "A" ? "Я:" : "Yo:", other = side === "A" ? "Он:" : "Él:";
      for (const kind of ["input", "output"] as const) {
        const rows = pane.locator("li").filter({ has: page.locator(".turn-author", { hasText: kind === "input" ? own : other }) });
        // DOM trims row edges; the unit replay separately checks all raw spaces and punctuation.
        await expect.poll(async () => (await rows.locator(".recent-turn-primary").allTextContents()).join("").replace(/\s/gu, ""))
          .toBe(record.expected[kind][side].replace(/\s/gu, ""));
      }
      await expect(pane.locator(".turn-author")).toHaveCount(await pane.locator("li").count());
      for (const row of await pane.locator(".recent-turn-primary").all()) await expect(row).toHaveAttribute("lang", side === "A" ? "ru" : "es");
    }
    await expect(page.locator(".unattributed-output li")).toHaveCount(0);
  };
  await check();
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await check();
  await page.screenshot({ path: testInfo.outputPath("caption-replay.png"), fullPage: true });
  expect(errors).toEqual([]);
});
