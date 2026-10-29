import { expect, test } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";
import sourceCases from "../../src/conversation/fixtures/live-ru-es-source.json" with { type: "json" };

for (const scenario of sourceCases) test(`recorded RU-ES originals keep their panes throughout ${scenario.name}`, async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "es");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  await harness.sourceActive();
  const expected: Record<string, string> = { A: "", B: "" };
  for (const turn of scenario.turns) {
    for (const [text, startMs, endMs] of turn.packets) await harness.inputDelta(String(text), Number(startMs), Number(endMs));
    expected[turn.side] += turn.packets.map(packet => packet[0]).join("");
    for (const side of ["A", "B"]) {
      await expect.poll(async () => (await page.getByTestId(`participant-pane-${side}`).locator(".recent-turn-primary").allTextContents()).join("").replace(/\s/g, ""))
        .toBe(expected[side]!.replace(/\s/g, ""));
    }
  }
});

test("RU-ES labels every original and late translation from each pane's viewpoint", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "es");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  await harness.sourceActive();
  await harness.inputDelta("Где находится вокзал?");
  await harness.advance(100);
  await harness.inputDelta("La estación está cerca.");
  await harness.advance(100);
  await harness.outputDelta("¿Dónde está la estación?");
  await harness.advance(100);
  await harness.outputDelta("Вокзал рядом.");
  await harness.advance(100);
  await harness.inputDelta("Спасибо за помощь.");
  await harness.advance(100);
  await harness.inputDelta("De nada.");
  await harness.advance(100);
  await harness.outputDelta("Gracias por la ayuda.");
  await harness.advance(100);
  await harness.outputDelta("Пожалуйста.");
  const a = page.getByTestId("participant-pane-A"), b = page.getByTestId("participant-pane-B");
  await expect(a.locator("li")).toHaveText([
    "Я: Где находится вокзал?", "Он: Вокзал рядом.", "Я: Спасибо за помощь.", "Он: Пожалуйста.",
  ]);
  await expect(b.locator("li")).toHaveText([
    "Yo: La estación está cerca.", "Él: ¿Dónde está la estación?", "Yo: De nada.", "Él: Gracias por la ayuda.",
  ]);
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await expect(page.getByRole("button", { name: "На начальный экран", exact: true })).toBeVisible();
  await expect(a.locator(".turn-author")).toHaveText(["Я:", "Он:", "Я:", "Он:"]);
  await expect(b.locator(".turn-author")).toHaveText(["Yo:", "Él:", "Yo:", "Él:"]);
  await page.screenshot({ path: testInfo.outputPath("ru-es-caption-labels.png") });
});

test("courier dialogue retains originals, translations and split names across caption idle", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  const startup = await harness.sentClientEvents();
  await harness.sourceActive();
  await harness.inputDelta("Так, здравствуйте. Кто вы? Что вы хотите?");
  await harness.inputDelta("Um, sir, hi. I'm a delivery guy. I ");
  await harness.outputDelta("Well, hello. Who are you, what do you ");
  await harness.advance(900);
  await harness.outputDelta("want?");
  await harness.inputDelta("need to deliver a package for Mr. Mikhail Gu");
  await harness.advance(900);
  await harness.inputDelta("shin.");
  await harness.outputDelta("Эм, сэр, привет. Я курьер. У меня посылка для господина Михаила Гу");
  await harness.advance(900);
  await harness.outputDelta("шина.");
  await harness.inputDelta("Ага, как мне получить посылку?");
  await harness.outputDelta("How do I get the package?");
  await harness.sourceQuiet();
  await harness.advance(6000);

  const a = page.getByTestId("participant-pane-A"), b = page.getByTestId("participant-pane-B");
  await expect(a.locator("li")).toHaveText([
    "Я: Так, здравствуйте. Кто вы? Что вы хотите?",
    "Он: Эм, сэр, привет. Я курьер. У меня посылка для господина Михаила Гушина.",
    "Я: Ага, как мне получить посылку?",
  ]);
  await expect(b.locator("li")).toHaveText([
    "Me: Um, sir, hi. I'm a delivery guy. I need to deliver a package for Mr. Mikhail Gushin.",
    "Him: Well, hello. Who are you, what do you want?",
    "Him: How do I get the package?",
  ]);
  await expect(a.locator(".turn-author")).toHaveText(["Я:", "Он:", "Я:"]);
  await expect(b.locator(".turn-author")).toHaveText(["Me:", "Him:", "Him:"]);
  await expect(a.locator("li").nth(1).locator(".recent-turn-primary")).toHaveAttribute("lang", "ru");
  await expect(b.locator("li").nth(1).locator(".recent-turn-primary")).toHaveAttribute("lang", "en");
  await expect(page.locator(".turn-waiting")).toHaveCount(0);
  await expect(page.getByText("Повторите", { exact: true })).toHaveCount(0);
  expect(await harness.lastGateBCommand()).toBe("unmute");
  expect(await harness.sentClientEvents()).toEqual(startup);
  await page.screenshot({ path: testInfo.outputPath("courier-caption-blocks.png") });
});

test("unknown output remains visible and unassigned beside a later identified phrase", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  await harness.outputDelta("OK");
  await harness.advance(900);
  await expect(page.locator(".participant-pane li")).toHaveCount(0);
  await expect(page.locator(".unassigned-captions")).toHaveCount(0);
  await expect(page.locator(".unattributed-output li")).toHaveText("OK");
  await expect(page.locator(".unattributed-output .turn-author")).toHaveCount(0);
  await expect(page.getByText("Повторите", { exact: true })).toHaveCount(0);
  await harness.outputDelta(", I can check that for you.");
  // The idle flush finalized the unknown group; later language evidence does not identify its owner.
  await expect(page.locator(".unattributed-output li")).toHaveText("OK");
  await expect(page.locator(".unattributed-output .turn-author")).toHaveCount(0);
  await expect(page.getByText("OK", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("participant-pane-B").locator("li")).toHaveText("Him: , I can check that for you.");
  await expect(page.getByTestId("participant-pane-B").locator(".turn-author")).toHaveText("Him:");
  await expect(page.getByTestId("participant-pane-B").locator(".recent-turn-primary")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Повторите", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("participant-pane-A").locator("li")).toHaveCount(0);
});

test("numbers and embedded brands stay in the complete caption on its language pane", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  const a = page.getByTestId("participant-pane-A"), b = page.getByTestId("participant-pane-B");
  await harness.sourceActive();
  await harness.inputDelta("12, ");
  await expect(page.locator(".participant-pane li")).toHaveCount(0);
  await harness.inputDelta("Я использую ");
  await harness.inputDelta("Google");
  await expect(b.locator("li")).toHaveCount(0);
  await harness.inputDelta(" каждый день.");
  await expect(a.locator("li")).toHaveText("Я: 12, Я использую Google каждый день.");
  await harness.inputDelta("I also use OpenAI every day.");
  await harness.outputDelta("Я тоже использую OpenAI каждый день.");
  await expect(a.locator("li")).toHaveText([
    "Я: 12, Я использую Google каждый день.", "Он: Я тоже использую OpenAI каждый день.",
  ]);
  await expect(b.locator("li")).toHaveText("Me: I also use OpenAI every day.");
  await expect(a.locator("li").last().locator(".turn-author")).toHaveText("Он:");
  await expect(a.locator("li").last().locator(".recent-turn-primary")).toHaveAttribute("lang", "ru");
  await page.screenshot({ path: testInfo.outputPath("caption-prefix-and-brands.png") });
});

test("short resolved captions and sentence-final names survive subsequent packets", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  const a = page.getByTestId("participant-pane-A"), b = page.getByTestId("participant-pane-B");
  await harness.inputDelta("Да.");
  await expect(a.locator("li")).toHaveText("Я: Да.");
  await harness.inputDelta(" 12");
  await expect(a.locator("li")).toContainText("Да.");
  await harness.inputDelta(" Please continue speaking.");
  await expect(a.locator("li")).toContainText("Да.");
  await expect(a.locator("li")).toHaveText("Я: Да.");
  await expect(b.locator("li")).toHaveText("Me: 12 Please continue speaking.");
  await harness.outputDelta("Наш новый офис теперь находится в New York.");
  await expect(a.locator("li").last()).toHaveText("Он: Наш новый офис теперь находится в New York.");
  await expect(a.locator("li").last().locator(".turn-author")).toHaveText("Он:");
  await expect(a.locator("li").last().locator(".recent-turn-primary")).toHaveAttribute("lang", "ru");
  await expect(b.locator("li")).toHaveCount(1);
});

test("untimed punctuation does not undo corrected caption word order", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  const caption = page.getByTestId("participant-pane-A").locator("li");
  await harness.inputDelta("Михаила Гушина", 1000, 1500);
  await harness.inputDelta("Посылка для ", 0, 500);
  await expect(caption).toHaveText("Я: Посылка для Михаила Гушина");
  await harness.inputDelta(".");
  await expect(caption).toHaveText("Я: Посылка для Михаила Гушина.");
});

test("short interruptions into unfinished speech appear on their own language pane", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  await harness.inputDelta("Подскажите, пожалуйста, где находится ");
  await harness.inputDelta("No.");
  const a = page.getByTestId("participant-pane-A"), b = page.getByTestId("participant-pane-B");
  await expect(a.locator("li")).toHaveText("Я: Подскажите, пожалуйста, где находится");
  await expect(b.locator("li")).toHaveText("Me: No.");
});

test("Japanese prolonged marks retain complete originals and translations", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "ja");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  await harness.inputDelta("コーヒー。");
  await harness.outputDelta("スーパーで待っています。");
  await expect(page.getByTestId("participant-pane-B").locator("li")).toHaveText(["Me: コーヒー。", "Him: スーパーで待っています。"]);
  await expect(page.getByTestId("participant-pane-B").locator("li").last().locator(".turn-author")).toHaveText("Him:");
  await expect(page.getByTestId("participant-pane-B").locator("li").last().locator(".recent-turn-primary")).toHaveAttribute("lang", "ja");
});

for (const [language, text] of [["hi", "हाँ।"], ["ar", "نعم؟"], ["ur", "جی۔"]] as const) {
  test("native " + language + " sentence endings retain short originals and translations", async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await page.addInitScript(language => {
      localStorage.setItem("live-translator-owner-language", "ru");
      localStorage.setItem("live-translator-interlocutor-language", language);
    }, language);
    await page.goto("/");
    await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
    await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
    for (const character of text) await harness.inputDelta(character);
    await harness.outputDelta(text);
    await expect(page.getByTestId("participant-pane-B").locator("li")).toHaveText(["Me: " + text, "Him: " + text]);
    await expect(page.getByTestId("participant-pane-B").locator("li").last().locator(".turn-author")).toHaveText("Him:");
    await expect(page.getByTestId("participant-pane-B").locator("li").last().locator(".recent-turn-primary")).toHaveAttribute("lang", language);
    await expect(page.getByTestId("participant-pane-A").locator("li")).toHaveCount(0);
  });
}

test("same-script replies retain quoted captions and pending translation status", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "en");
    localStorage.setItem("live-translator-interlocutor-language", "es");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start translation", exact: true }).click();
  await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
  await harness.sourceActive();
  await harness.inputDelta("“Where is the station?");
  await harness.inputDelta("”");
  await expect(page.getByTestId("participant-pane-A").locator("li")).toHaveText("Me: “Where is the station?”");
  await harness.inputDelta("La estación está cerca del supermercado.");
  await harness.sourceQuiet();
  await harness.outputDelta("Sí.");
  await expect(page.getByTestId("participant-status-B")).toHaveText("Traduciendo");
  await expect(page.getByTestId("participant-status-A")).toHaveText("Please wait");
  await expect(page.getByTestId("participant-pane-B").locator("li")).toHaveText([
    "Yo: La estación está cerca del supermercado.", "Él: Sí.",
  ]);
  await expect(page.getByTestId("participant-pane-B").locator("li").last().locator(".turn-author")).toHaveText("Él:");
  await expect(page.getByTestId("participant-pane-B").locator("li").last().locator(".recent-turn-primary")).toHaveAttribute("lang", "es");
  await harness.advance(1000);
  await expect(page.getByTestId("participant-status-B")).not.toHaveText("Traduciendo");
});

test("adjacent quotes and buffered ambiguous replies stay in their own caption blocks", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "en");
    localStorage.setItem("live-translator-interlocutor-language", "es");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start translation", exact: true }).click();
  await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
  await harness.sourceActive();
  await harness.inputDelta("Where is the station?");
  await harness.inputDelta('"La estación está cerca del supermercado."');
  const a = page.getByTestId("participant-pane-A"), b = page.getByTestId("participant-pane-B");
  await expect(a.locator("li")).toHaveText("Me: Where is the station?");
  await expect(b.locator("li")).toHaveText('Yo: "La estación está cerca del supermercado."');
  await harness.advance(1);
  await harness.outputDelta("No.");
  await harness.outputDelta(" Sí.");
  await harness.advance(1);
  await harness.inputDelta("No.");
  await harness.inputDelta(" Sí.");
  await expect(b.locator("li")).toHaveText(['Yo: "La estación está cerca del supermercado."', "Él: Sí.", "Yo: Sí."]);
  await expect(b.locator("li").nth(1).locator(".turn-author")).toHaveText("Él:");
  await expect(b.locator("li").nth(1).locator(".recent-turn-primary")).toHaveAttribute("lang", "es");
  await expect(page.locator(".participant-pane li")).toHaveCount(4);
});

test("stopped playback with retained translated text does not keep an output indicator", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "en");
    localStorage.setItem("live-translator-interlocutor-language", "es");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start translation", exact: true }).click();
  await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
  await harness.sourceActive();
  await harness.inputDelta("Where is the train station?");
  await harness.outputDelta("Sí.");
  await harness.sourceQuiet();
  await harness.playbackActive();
  const status = page.getByTestId("participant-status-B");
  await expect(status).toHaveText("Escucha la traducción");
  await harness.playbackIdle();
  await expect(status).not.toHaveText("Escucha la traducción");
  await expect(status).not.toHaveText("Traduciendo");
  await expect(page.getByTestId("participant-pane-B").locator("li")).toHaveText("Él: Sí.");
  await expect(page.getByTestId("participant-pane-B").locator(".turn-author")).toHaveText("Él:");
  await expect(page.getByTestId("participant-pane-B").locator(".recent-turn-primary")).toHaveAttribute("lang", "es");
});


test("unknown-language captions follow new output and preserve intentional manual reading", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  for (let index = 0; index < 14; index++) {
    await harness.outputDelta("OK.");
    await harness.advance(900);
  }
  const scroll = page.locator(".unattributed-output");
  await expect(scroll.locator("li")).toHaveCount(14);
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  await expect(scroll.locator("li").last()).toBeInViewport();
  await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await harness.outputDelta("OK!"); await harness.advance(900);
  await expect(scroll.locator("li")).toHaveCount(15);
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(0);
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
  await harness.outputDelta("OK?"); await harness.advance(900);
  await expect(scroll.locator("li")).toHaveCount(16);
  await expect(scroll.locator("li").last()).toHaveText("OK?");
  await expect(scroll.locator(".turn-author")).toHaveCount(0);
  await expect(scroll.locator("li").last()).toBeInViewport();
});

for (const ambiguous of [false, true]) {
  test(`B's timed-out speech gets B-facing Spanish recovery, ambiguous=${ambiguous}`, async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await page.addInitScript(() => {
      localStorage.setItem("live-translator-owner-language", "ru");
      localStorage.setItem("live-translator-interlocutor-language", "es");
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
    await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
    await harness.sourceActive();
    await harness.inputDelta("¿Dónde está la estación de tren?");
    await harness.sourceQuiet();
    if (ambiguous) { await harness.playbackActive(); await harness.playbackIdle(); }
    await harness.advance(6000);
    const b = page.getByTestId("participant-pane-B");
    const prompt = b.getByTestId("participant-recovery-B");
    await expect(b.getByRole("status")).toContainText(ambiguous ? "Si no has oído la traducción, repite la frase" : "Repite");
    await expect(prompt).toHaveText(ambiguous ? "Si no has oído la traducción, repite la frase" : "Repite");
    await expect(prompt).toHaveAttribute("lang", "es");
    await expect(prompt).toBeInViewport();
    expect(await b.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBeCloseTo(-1);
    await expect(page.getByTestId("participant-pane-A").getByText("Повторите", { exact: true })).toHaveCount(0);
    await expect(page.locator(".conversation-center").getByText(/Повторите|Если перевод/)).toHaveCount(0);
  });
}
