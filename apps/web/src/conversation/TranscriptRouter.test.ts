import { describe, expect, it } from "vitest";
import { TranscriptRouter } from "./TranscriptRouter";
import type { TranscriptFragment } from "./TranscriptFragment";

const languages = { A: "ru", B: "en" };
const fragment = (text: string, startMs = 0): TranscriptFragment => ({ id: text, text, receivedAtMs: 1000, startMs, endMs: startMs + 50 });

describe("streaming language evidence", () => {
  it("uses the configured pair without changing the general setup detector", () => {
    const router = new TranscriptRouter();
    expect(router.push(fragment("Подскажите, пожалуйста, мне нужна информация."), languages)[0]?.side).toBe("A");
    router.reset();
    expect(router.push(fragment("Γειά σας, ποιος είναι ο δρόμος;"), languages)).toEqual([]);
    expect(router.flush(languages)[0]?.side).toBeUndefined();
  });
  it("does not classify a misleading unfinished word using its expected translation direction", () => {
    const router = new TranscriptRouter();
    const pair = { A: "en", B: "es" };
    expect(router.push(fragment("Thank y"), pair, "B")).toEqual([]);
    const routed = router.push(fragment("ou very much."), pair, "B");
    expect(routed[0]?.side).toBe("A");
    expect(routed[0]?.fragments.map(part => part.text).join("")).toBe("Thank you very much.");
  });
  it("identifies the new speaker before concatenating their answer with the old source", () => {
    const router = new TranscriptRouter();
    expect(router.push(fragment("The station is straight ahead.", 300), languages, "A")).toEqual([
      { side: "B", fragments: [fragment("The station is straight ahead.", 300)] },
    ]);
  });

  it("keeps a misleading unfinished word buffered across caption idle", () => {
    const router = new TranscriptRouter();
    const pair = { A: "en", B: "es" };
    expect(router.push(fragment(" Thank y"), pair, "A")).toEqual([]);
    expect(router.flush(pair)).toEqual([]);
    const routed = router.push(fragment("ou very much."), pair, "A");
    expect(routed[0]?.side).toBe("A");
    expect(routed[0]?.fragments.map(part => part.text).join("")).toBe(" Thank you very much.");
  });

  it("resolves a short complete phrase at idle when its completed prefix supports the same language", () => {
    const router = new TranscriptRouter();
    const pair = { A: "en", B: "es" };
    expect(router.push(fragment("Thank you"), pair, "B")).toEqual([]);
    expect(router.flush(pair)[0]).toMatchObject({ side: "A", fragments: [fragment("Thank you")] });
  });

  it("holds a partial English word and preserves its timestamps when the language resolves", () => {
    const router = new TranscriptRouter();
    expect(router.push(fragment("The", 300), languages, "A")).toEqual([]);
    const routed = router.push(fragment(" station is straight ahead.", 350), languages, "A");
    expect(routed[0]?.side).toBe("B");
    expect(routed[0]?.fragments.map(f => [f.text, f.startMs])).toEqual([["The", 300], [" station is straight ahead.", 350]]);
  });

  it("retains a borrowed word with its surrounding Russian speech", () => {
    const router = new TranscriptRouter();
    expect(router.push(fragment("hotel"), languages, "A")).toEqual([]);
    const routed = router.push(fragment(" находится рядом с вокзалом."), languages, "A");
    expect(routed[0]?.side).toBe("A");
    expect(routed[0]?.fragments.map(f => f.text).join("")).toBe("hotel находится рядом с вокзалом.");
  });

  it("flushes an ambiguous short reply without guessing its author", () => {
    const router = new TranscriptRouter();
    expect(router.push(fragment("OK"), languages, "A")).toEqual([]);
    expect(router.flush(languages)[0]).toMatchObject({ side: undefined, fragments: [fragment("OK")] });
  });

  it("bounds undecidable evidence without losing the received text", () => {
    const router = new TranscriptRouter();
    const text = "12345 ".repeat(100);
    const routed = router.push(fragment(text), languages);
    expect(routed[0]?.fragments.map(f => f.text).join("")).toBe(text);
    expect(router.flush(languages)).toEqual([]);
  });

  it("does not replay buffered speech after reset", () => {
    const router = new TranscriptRouter();
    router.push(fragment("OK"), languages);
    router.reset();
    expect(router.flush(languages)).toEqual([]);
  });
});

it.each(["Привет.", "Да.", "Нет."])("routes complete short Cyrillic handoff %s", text => {
  const router = new TranscriptRouter();
  const part = fragment(text);
  const routed = [...router.push(part, languages, "B"), ...router.flush(languages)];
  expect(routed).toEqual([{ side: "A", fragments: [part] }]);
});

it("routes complete short Chinese speech without relying on character count", () => {
  const router = new TranscriptRouter();
  const pair = { A: "zh", B: "en" };
  const part = fragment("你好。");
  expect(router.push(part, pair, "B")).toEqual([{ side: "A", fragments: [part] }]);
});

it("keeps a reliable opposite-language reply even after unfinished source context", () => {
  const router = new TranscriptRouter();
  expect(router.push(fragment("Привет."), languages, "B", "Well, I was thinking ")[0]?.side).toBe("A");
});

it("does not retain source context after reset or when the next source is empty", () => {
  const router = new TranscriptRouter();
  expect(router.push(fragment("Google."), languages, "A", "Я использую ")[0]?.side).toBe("A");
  router.reset();
  expect(router.push(fragment("Google."), languages, "A")[0]?.side).toBe("B");
});

it.each([
  ["B", "The station is straight ahead and ", "Да.", "A"],
  ["B", "The station is straight ahead and ", "Нет.", "A"],
  ["A", "Я хочу спросить вас ", "Yes.", "B"],
  ["A", "Я хочу спросить вас ", "No.", "B"],
] as const)("preserves a short %s interruption after %s: %s", (current, context, text, next) => {
  const router = new TranscriptRouter();
  expect(router.push(fragment(text), languages, current, context)[0]?.side).toBe(next);
});


it.each(["IBM.", "AI.", "OK."])("uses source context for short foreign token %s", text => {
  const router = new TranscriptRouter();
  expect(router.push(fragment(text), languages, "A", "Я работаю в ")[0]?.side).toBe("A");
});

it.each(["Stop.", "Wait.", "Why?", "Hi."])("preserves a brief English reply after Russian unfinished speech: %s", text => {
  const router = new TranscriptRouter();
  expect(router.push(fragment(text), languages, "A", "Я хочу спросить вас ")[0]?.side).toBe("B");
});
