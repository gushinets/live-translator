import { describe, expect, it } from "vitest";
import { DialogueTranscript } from "./DialogueTranscript";
import type { TranscriptFragment } from "./TranscriptFragment";

const pair = { A: "ru", B: "en" };
let sequence = 0;
function fragment(text: string, receivedAtMs = sequence++ * 900): TranscriptFragment {
  return { id: String(sequence++), text, receivedAtMs };
}
const content = (transcript: DialogueTranscript) => transcript.blocks.map(({ kind, side, text }) => ({ kind, side, text: text.trim() }));

describe("independent dialogue captions", () => {
  it.each([1, 2, 7, 1000])("retains courier names and short suffixes regardless of packet size %i and idle gaps", size => {
    const transcript = new DialogueTranscript();
    const text = "Да, да, да. Я курьер, и у меня есть посылка для господина Михаила Гушина.";
    for (let offset = 0; offset < text.length; offset += size) transcript.push("output", fragment(text.slice(offset, offset + size)), pair);
    expect(content(transcript)).toEqual([{ kind: "output", side: "A", text }]);
  });

  it("preserves both participants' originals and translations without pairing, including late translation", () => {
    const transcript = new DialogueTranscript();
    transcript.push("input", fragment("Так, здравствуйте. Кто вы?", 1), pair);
    transcript.push("input", fragment("Um, sir, hi. I'm a delivery guy, I ", 2), pair);
    transcript.push("output", fragment("Well, hello. Who are you, what do you ", 3), pair);
    transcript.push("output", fragment("want?", 2000), pair);
    transcript.push("input", fragment("need to deliver a package for you.", 3000), pair);
    transcript.push("output", fragment("Эм, сэр, привет. Я курьер. Думаю, мне нужно доставить ", 4000), pair);
    transcript.push("output", fragment("вам посылку, наверное.", 5000), pair);
    expect(content(transcript)).toEqual([
      { kind: "input", side: "A", text: "Так, здравствуйте. Кто вы?" },
      { kind: "input", side: "B", text: "Um, sir, hi. I'm a delivery guy, I need to deliver a package for you." },
      { kind: "output", side: "B", text: "Well, hello. Who are you, what do you want?" },
      { kind: "output", side: "A", text: "Эм, сэр, привет. Я курьер. Думаю, мне нужно доставить вам посылку, наверное." },
    ]);
  });

  it.each([1, 5, 1000])("splits fast A-B-A even inside one packet, size %i", size => {
    const transcript = new DialogueTranscript();
    const text = "Где вокзал?The station is straight ahead.Спасибо, я понял.";
    for (let offset = 0; offset < text.length; offset += size) transcript.push("input", fragment(text.slice(offset, offset + size)), pair);
    expect(content(transcript)).toEqual([
      { kind: "input", side: "A", text: "Где вокзал?" },
      { kind: "input", side: "B", text: "The station is straight ahead." },
      { kind: "input", side: "A", text: "Спасибо, я понял." },
    ]);
  });

  it("retains unresolved speech once and later resolves it using the accumulated phrase", () => {
    const transcript = new DialogueTranscript();
    transcript.push("output", fragment("OK"), pair);
    expect(content(transcript)).toEqual([{ kind: "output", side: undefined, text: "OK" }]);
    transcript.push("output", fragment(", I can check that for you."), pair);
    expect(content(transcript)).toEqual([{ kind: "output", side: "B", text: "OK, I can check that for you." }]);
  });

  it("does not classify unfinished same-script words on a network pause", () => {
    const transcript = new DialogueTranscript();
    const languages = { A: "en", B: "es" };
    transcript.push("output", fragment("¿Dónde está la estación de tren? Thank y"), languages);
    expect(transcript.blocks.at(-1)?.side).toBeUndefined();
    transcript.push("output", fragment("ou very much."), languages);
    expect(content(transcript)).toEqual([
      { kind: "output", side: "B", text: "¿Dónde está la estación de tren?" },
      { kind: "output", side: "A", text: "Thank you very much." },
    ]);
  });

  it("orders timed packets within a stream, retaining punctuation and numbers", () => {
    const transcript = new DialogueTranscript();
    transcript.push("output", { ...fragment("Михаила Гушина, 12.", 1), startMs: 10 }, pair);
    transcript.push("output", { ...fragment("Посылка для ", 2), startMs: 0 }, pair);
    expect(content(transcript)).toEqual([{ kind: "output", side: "A", text: "Посылка для Михаила Гушина, 12." }]);
  });

  it("does not let a preceding packet's trailing whitespace backdate the next language run", () => {
    const transcript = new DialogueTranscript();
    const languages = { A: "en", B: "es" };
    transcript.push("input", fragment("Where is the train station? ", 1), languages);
    transcript.push("output", fragment("¿Dónde está la estación de tren? ", 2), languages);
    transcript.push("input", fragment("¿Podría decirme dónde está la estación de tren?", 3), languages);
    transcript.push("output", fragment("Could you tell me where the train station is?", 4), languages);
    expect(transcript.blocks.map(block => [block.kind, block.side, block.receivedAtMs])).toEqual([
      ["input", "A", 1], ["output", "B", 2], ["input", "B", 3], ["output", "A", 4],
    ]);
  });

  it("preserves source timestamp order across language runs while merging delayed output", () => {
    const transcript = new DialogueTranscript();
    transcript.push("input", { ...fragment("Спасибо за помощь.", 1), startMs: 20 }, pair);
    transcript.push("input", { ...fragment("The station is ahead.", 2), startMs: 10 }, pair);
    transcript.push("input", { ...fragment("Где находится вокзал?", 3), startMs: 0 }, pair);
    transcript.push("output", fragment("Where is the station?", 4), pair);
    expect(transcript.blocks.map(block => block.text)).toEqual([
      "Где находится вокзал?", "The station is ahead.", "Спасибо за помощь.", "Where is the station?",
    ]);
  });

  it("seals lifecycle generations and preserves old language labels on a language change", () => {
    const transcript = new DialogueTranscript();
    transcript.push("output", fragment("A package for you."), pair);
    transcript.seal();
    transcript.push("output", fragment("Ein Paket für Sie."), { A: "ru", B: "de" });
    expect(transcript.blocks.map(block => block.language)).toEqual(["en", "de"]);
    transcript.clear();
    expect(transcript.blocks).toEqual([]);
  });

  it("retains unsupported-script text unassigned rather than attaching it to a configured speaker", () => {
    const transcript = new DialogueTranscript();
    transcript.push("input", fragment("Γειά σας"), pair);
    expect(content(transcript)).toEqual([{ kind: "input", side: undefined, text: "Γειά σας" }]);
  });

  it.each([{ A: "ja", B: "zh" }, { A: "zh", B: "ja" }])("does not treat shared Han characters as disjoint scripts: %j", languages => {
    const transcript = new DialogueTranscript();
    transcript.push("input", fragment("请问火车站在哪里？我想买一张去北京的车票。"), languages);
    transcript.push("input", fragment("すみません、駅はどこにありますか？東京までの切符を買いたいです。"), languages);
    expect(transcript.blocks.filter(block => block.text.trim()).map(block => block.language)).toEqual(["zh", "ja"]);
  });
});

describe("PR32 caption context regressions", () => {
  it.each([1, 5, 1000])("keeps brands and borrowed words with surrounding speech at packet size %i", size => {
    for (const text of ["Я использую Google каждый день.", "hotel находится рядом с вокзалом.", "Я использую OpenAI.", "Привет Google.", "Спасибо Google за помощь.", "Привет, John!", "Использую Google.", "We met Михаил at the station."]) {
      const transcript = new DialogueTranscript();
      for (let offset = 0; offset < text.length; offset += size) transcript.push("input", fragment(text.slice(offset, offset + size)), pair);
      const side = text.startsWith("We") ? "B" : "A";
      expect(content(transcript)).toEqual([{kind: "input", side, text}]);
    }
  });
  it.each(["12, Привет", "—Hello", "«Здравствуйте», это квартира 12."])("keeps a leading neutral prefix with resolved language: %s", text => {
    const transcript = new DialogueTranscript();
    for (const character of text) transcript.push("input", fragment(character), pair);
    expect(transcript.blocks.filter(block => block.side).map(block => block.text).join("")).toBe(text);
  });
});

it("retains actual short replies and rapid language switches around borrowed words", () => {
  const transcript = new DialogueTranscript();
  const text = "Я использую Google. Hello.Я знаю OpenAI. The station is ahead.";
  for (const character of text) transcript.push("input", fragment(character), pair);
  expect(content(transcript)).toEqual([
    {kind: "input", side: "A", text: "Я использую Google."},
    {kind: "input", side: "B", text: "Hello."},
    {kind: "input", side: "A", text: "Я знаю OpenAI."},
    {kind: "input", side: "B", text: "The station is ahead."},
  ]);
});

it("preserves a brand inside unspaced Chinese speech", () => {
  const transcript = new DialogueTranscript();
  const text = "我每天使用Google搜索信息。";
  for (const character of text) transcript.push("input", fragment(character), { A: "zh", B: "en" });
  expect(content(transcript)).toEqual([{ kind: "input", side: "A", text }]);
});

describe("PR32 short replies and multiword names", () => {
  it.each([
    ["input", "ru", "Да."], ["output", "ru", "Да."],
    ["input", "ru", "Нет."], ["output", "ru", "Нет."],
    ["input", "zh", "你好。"], ["output", "zh", "你好。"],
  ] as const)("retains complete short %s %s %s replies", (kind, language, text) => {
    const transcript = new DialogueTranscript();
    const pair = { A: language, B: "en" };
    transcript.push(kind, { id: "1", text, receivedAtMs: 0 }, pair);
    transcript.push(kind, { id: "2", text: "The station is straight ahead.", receivedAtMs: 1 }, pair);
    expect(transcript.blocks[0], text).toMatchObject({ side: "A", text });
  });
  it.each([1, 5, 1000])("retains embedded multiword names at packet size %i", size => {
    for (const kind of ["input", "output"] as const) {
      const transcript = new DialogueTranscript();
      const text = "Я живу в New York рядом с вокзалом.";
      for (let offset = 0; offset < text.length; offset += size) transcript.push(kind, fragment(text.slice(offset, offset + size)), pair);
      transcript.push(kind, fragment("The station is straight ahead."), pair);
      expect(content(transcript)).toEqual([
        { kind, side: "A", text },
        { kind, side: "B", text: "The station is straight ahead." },
      ]);
    }
  });
});

it.each(["input", "output"] as const)("preserves short reply through neutral tail: %s", kind => {
  const transcript = new DialogueTranscript();
  for (const [i, text] of ["Да.", " 12", " Please continue speaking."].entries()) transcript.push(kind, { id: String(i), text, receivedAtMs: i }, pair);
  expect(transcript.blocks.filter(block => block.side === "A").map(block => block.text).join("")).toContain("Да.");
});
it.each([1, 5, 1000])("preserves sentence-final multiword name at packet size %s", size => {
  const transcript = new DialogueTranscript();
  const text = "Наш новый офис теперь находится в New York.";
  for (let offset = 0; offset < text.length; offset += size) transcript.push("input", fragment(text.slice(offset, offset + size)), pair);
  expect(content(transcript)).toEqual([{ kind: "input", side: "A", text }]);
});
it.each(["input", "output"] as const)("preserves known timestamp ordering with untimed suffix: %s", kind => {
  const transcript = new DialogueTranscript();
  transcript.push(kind, { id:"1", text:"Михаила Гушина", startMs:1000, receivedAtMs:0 }, pair);
  transcript.push(kind, { id:"2", text:"Посылка для ", startMs:0, receivedAtMs:1 }, pair);
  expect(transcript.blocks.map(block=>block.text).join("")).toBe("Посылка для Михаила Гушина");
  transcript.push(kind, { id:"3", text:".", receivedAtMs:2 }, pair);
  expect(transcript.blocks.map(block=>block.text).join("")).toBe("Посылка для Михаила Гушина.");
});


it.each(["Я из New York.", "Я использую Google и OpenAI.", "Я в Google каждый день."])("keeps short host-language spans within their contextual sentence: %s", text => {
  const transcript = new DialogueTranscript();
  for (const character of text) transcript.push("input", fragment(character), pair);
  expect(content(transcript)).toEqual([{ kind: "input", side: "A", text }]);
});

it.each(["input", "output"] as const)("keeps explicit interruptions separate in the %s stream across packets", kind => {
  const transcript = new DialogueTranscript();
  transcript.push(kind, fragment("Подскажите, пожалуйста, где находится "), pair);
  for (const letter of "No.") transcript.push(kind, fragment(letter), pair);
  expect(content(transcript)).toEqual([
    { kind, side: "A", text: "Подскажите, пожалуйста, где находится" },
    { kind, side: "B", text: "No." },
  ]);
  transcript.push(kind, fragment(" Я использую IBM."), pair);
  expect(content(transcript)).toEqual([
    { kind, side: "A", text: "Подскажите, пожалуйста, где находится" },
    { kind, side: "B", text: "No." },
    { kind, side: "A", text: "Я использую IBM." },
  ]);
});
