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

it.each([1, 2, 1000])("preserves Japanese prolonged sound marks at packet size %i", size => {
  for (const kind of ["input", "output"] as const) for (const text of ["コーヒー。", "タクシー。", "スーパーで待っています。"]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "ja" });
    expect(content(transcript)).toEqual([{ kind, side: "B", text }]);
  }
});
it("preserves a German short interruption into unfinished Russian speech", () => {
  const transcript = new DialogueTranscript();
  transcript.push("input", fragment("Подскажите, пожалуйста, где находится "), { A: "ru", B: "de" });
  transcript.push("input", fragment("Ja."), { A: "ru", B: "de" });
  expect(content(transcript)).toEqual([
    { kind: "input", side: "A", text: "Подскажите, пожалуйста, где находится" },
    { kind: "input", side: "B", text: "Ja." },
  ]);
});

it.each([
  ["de", "Ja."], ["fr", "Oui."], ["es", "Sí."], ["es", "Si\u0301."], ["ja", "はい。"], ["ar", "نعم."], ["hi", "हाँ."],
])("retains a short %s reply in both streams: %s", (language, reply) => {
  for (const kind of ["input", "output"] as const) {
    const transcript = new DialogueTranscript();
    const languages = { A: "ru", B: language };
    transcript.push(kind, fragment("Подскажите, пожалуйста, где находится "), languages);
    transcript.push(kind, fragment(reply), languages);
    expect(content(transcript)).toEqual([
      { kind, side: "A", text: "Подскажите, пожалуйста, где находится" },
      { kind, side: "B", text: reply },
    ]);
  }
});

it.each([
  ["ru", "fr", "Cafe\u0301."], ["en", "ru", "Да\u0301."], ["ru", "el", "ο\u0301χι."],
])("keeps shared combining marks with their base letters in %s/%s", (A, B, text) => {
  const transcript = new DialogueTranscript();
  for (const character of text) transcript.push("input", fragment(character), { A, B });
  expect(content(transcript)).toEqual([{ kind: "input", side: "B", text }]);
});

it.each([
  ["hi", "हाँ।"], ["ar", "نعم؟"], ["ur", "جی۔"],
])("retains native sentence terminators in %s captions: %s", (language, text) => {
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: language, B: "en" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text }]);
    transcript.push(kind, fragment(" 12 Please continue speaking."), { A: language, B: "en" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text }, { kind, side: "B", text: "12 Please continue speaking." }]);
  }
});
it.each(["Dobar dan.", "Ovo je moja kuća i želim da razgovaram sa vama."])("does not label Latin Serbian as English: %s", text => {
  const transcript = new DialogueTranscript();
  transcript.push("input", fragment(text), { A: "en", B: "sr" });
  expect(content(transcript)).toEqual([{ kind: "input", side: undefined, text }]);
});

it.each([["sr", "Да."], ["pa", "ਹਾਂ।"], ["ms", "يا."]])("retains unique-script replies for multiscript %s", (language, text) => {
  for (const kind of ["input", "output"] as const) {
    const transcript = new DialogueTranscript();
    for (const character of text) transcript.push(kind, fragment(character), { A: "en", B: language });
    expect(content(transcript)).toEqual([{ kind, side: "B", text }]);
  }
});

it.each(["I would like to visit Москва tomorrow.", "I use Гугл every day.", "Please ask Иван to call me tomorrow."])("keeps English with embedded Cyrillic names in an en/sr pair: %s", text => {
  const transcript = new DialogueTranscript();
  transcript.push("input", fragment(text), { A: "en", B: "sr" });
  expect(content(transcript)).toEqual([{ kind: "input", side: "A", text }]);
});

it.each(["input", "output"] as const)("keeps same-script short replies visible in %s", kind => {
  const transcript = new DialogueTranscript();
  for (const character of "Sí.") transcript.push(kind, fragment(character), { A: "en", B: "es" });
  expect(content(transcript)).toEqual([{ kind, side: "B", text: "Sí." }]);
});
it.each(["“Where is the station?”", "«Where is the station?»", "(Where is the station?)", '"Where is the station?"'])("retains closing punctuation: %s", text => {
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text }]);
    transcript.push(kind, fragment(" “La estación está cerca del supermercado.”"), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text }, { kind, side: "B", text: "“La estación está cerca del supermercado.”" }]);
  }
});

it("does not turn shared No into exclusive English or Spanish evidence", () => {
  const transcript = new DialogueTranscript();
  transcript.push("input", fragment("No."), { A: "en", B: "es" });
  expect(content(transcript)).toEqual([{ kind: "input", side: undefined, text: "No." }]);
});

it.each(['"', "'"])("keeps the next sentence's unmatched opening %s on its language pane", quote => {
  const opening = "Where is the station?", reply = quote + "La estación está cerca del supermercado." + quote;
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    const text = opening + reply;
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: opening }, { kind, side: "B", text: reply }]);
  }
});
it.each([["en", "it", "Fine."], ["ru", "uk", "Стоп."]])("keeps lexical overlap unassigned in %s/%s captions", (A, B, text) => {
  for (const kind of ["input", "output"] as const) {
    const transcript = new DialogueTranscript();
    transcript.push(kind, fragment(text), { A, B });
    expect(content(transcript)).toEqual([{ kind, side: undefined, text }]);
  }
});

it.each(['"Where is the station?"', '"Where is the station?".', "I don't know. Where is the station?"])("keeps matched quotes and apostrophes before adjacent quoted speech: %s", opening => {
  const reply = '"La estación está cerca del supermercado."';
  const transcript = new DialogueTranscript();
  transcript.push("input", fragment(opening + reply), { A: "en", B: "es" });
  expect(content(transcript)).toEqual([{ kind: "input", side: "A", text: opening }, { kind: "input", side: "B", text: reply }]);
});


it.each(["input", "output"] as const)("retains quoted replies after measurement marks in %s", kind => {
  const opening = 'He is 6\'2" tall.', reply = '"Sí."';
  for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    const text = opening + " " + reply;
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: opening }, { kind, side: "B", text: reply }]);
  }
});


it.each([
  { text: '"He is 6\'2" tall."' },
  { text: '"It is 12" long."' },
  { text: "'The board is 6' long.'" },
  { text: "'The dogs' owner is here.'" },
  { text: "\"It is 12\", not 10.\"" },
  { text: "\"The board is 12\".\"" },
  { text: "'It is 6', not 5.'" },
  { text: "\"The board is 12\" x 6\" long.\"" },
  { text: "'The dogs' collars and cats' toys are here.'" },
].flatMap(example => (["input", "output"] as const).map(kind => ({ ...example, kind }))))("retains outer quotes around measurement/possessive marks in $kind: $text", ({ text, kind }) => {
  for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    const reply = '"Sí."', source = text + " " + reply;
    for (let i = 0; i < source.length; i += size) transcript.push(kind, fragment(source.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text }, { kind, side: "B", text: reply }]);
  }
});


it.each(["input", "output"] as const)("keeps a hostname separate from a following Spanish sentence in %s", kind => {
  const transcript = new DialogueTranscript();
  const first = "Visit example.com.", second = "La estación está cerca del supermercado.";
  transcript.push(kind, fragment(first + " " + second), { A: "en", B: "es" });
  expect(content(transcript)).toEqual([{ kind, side: "A", text: first }, { kind, side: "B", text: second }]);
});


it("retains both panes' quotes after a quoted noun and adjacent reply", () => {
  const transcript = new DialogueTranscript();
  transcript.push("input", fragment("'Dogs' owner is here.'Sí.'"), { A: "en", B: "es" });
  expect(content(transcript)).toEqual([
    { kind: "input", side: "A", text: "'Dogs' owner is here." }, { kind: "input", side: "B", text: "'Sí.'" },
  ]);
});


it("retains an outer possessive quote before an unquoted other-language sentence", () => {
  const transcript = new DialogueTranscript();
  const first = "'The dogs' owner is here.'", second = "La estación está cerca del supermercado.";
  transcript.push("input", fragment(first + second), { A: "en", B: "es" });
  expect(content(transcript)).toEqual([{ kind: "input", side: "A", text: first }, { kind: "input", side: "B", text: second }]);
});

it.each(["input", "output"] as const)("keeps an unlisted weak utterance unassigned before another language in %s", kind => {
  const reply = "La estación está cerca del supermercado.";
  for (const weak of ["OK.", "Uh."]) for (const chunks of [[weak, " " + reply], [weak + " " + reply]]) {
    const transcript = new DialogueTranscript();
    for (const text of chunks) transcript.push(kind, fragment(text), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: undefined, text: weak }, { kind, side: "B", text: reply }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(chunks.join(""));
  }
});

it.each(["input", "output"] as const)("shows new language evidence after an exhausted detection prefix in %s", kind => {
  for (const count of [399, 400]) {
    const transcript = new DialogueTranscript();
    const prefix = "123. ".repeat(count), text = "Where is the station?";
    transcript.push(kind, fragment(prefix), { A: "en", B: "es" });
    transcript.push(kind, fragment(text), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: undefined, text: prefix.trim() }, { kind, side: "A", text }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(prefix + text);
  }
});

it.each(['"2 personas están aquí."', '"¿Dónde está la estación?"', '"(2 personas están aquí.)"'])("keeps a numeric quotation separate from the next quoted reply in both streams: %s", reply => {
  const source = 'He said "123" and left.';
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript(), text = source + reply;
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: source }, { kind, side: "B", text: reply }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it.each(["input", "output"] as const)("samples language after a single oversized neutral prefix in %s", kind => {
  const prefix = "123 ".repeat(600), text = "Where is the station?";
  for (const chunks of [[prefix + text], [prefix, text]]) {
    const transcript = new DialogueTranscript();
    for (const chunk of chunks) transcript.push(kind, fragment(chunk), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: prefix + text }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(prefix + text);
  }
});

it.each(["Visit example.com","Visit \"example.com\"","Visit (example.com)"])("keeps a hostname without a final sentence terminal in both streams: %s", text => {
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text }]);
  }
});

it.each(["I loved the '90s.","I left 'cause it was late.","I looked 'round.","I asked 'bout.","'90s were great. Music was better.'","'cause it was late. I left early.'","'cause I don't know. I left early.'","'cause 'twas late. I left early.'"])("keeps leading lexical apostrophes in both caption streams: %s", source => {
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript(), text = source + " 'Sí.'";
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: source }, { kind, side: "B", text: "'Sí.'" }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it.each(['"La estación está cerca del supermercado', '"La estación está cerca del supermercado"'])("preserves an unpunctuated quoted tail in both caption streams: %s", reply => {
  const source = 'He said "123" and left.';
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript(), text = source + reply;
    for (let i = 0; i < text.length; i += size) {
      transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
      if (i + size > source.length + 1) expect(content(transcript)[0]).toEqual({ kind, side: "A", text: source });
    }
    expect(content(transcript)).toEqual([{ kind, side: "A", text: source }, { kind, side: "B", text: reply }]);
  }
});

it.each([
  { languages: { A: "en", B: "fr" }, side: "B", text: "Veuillez ouvrir le site example.no." },
  { languages: { A: "fr", B: "en" }, side: "A", text: 'Veuillez ouvrir le site "example.no".' },
])("keeps a canonical hostname suffix in both caption streams: $text", ({ languages, side, text }) => {
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), languages);
    expect(content(transcript)).toEqual([{ kind, side, text }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it.each(["I stayed 'cept.", "I waited 'neath.", "I said 'scuse.", "I left 'Cause it was late."])("keeps an unlisted leading elision's reply quoted in both caption streams: %s", source => {
  for (const reply of ["'Sí.'", "'sí.'"]) for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript(), text = source + " " + reply;
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: source }, { kind, side: "B", text: reply }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it.each([
  { text: "'It was quiet.' Sí. ' sí.'", reply: "Sí. ' sí.'" },
  { text: "'It was quiet.' Sí.' sí.'", reply: "Sí.' sí.'" },
  { text: "'It was quiet.'Sí.' sí.'", reply: "Sí.' sí.'" },
])("preserves the earlier quote before unquoted and padded quoted captions: $text", ({ text, reply }) => {
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: "'It was quiet.'" }, { kind, side: "B", text: reply }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it("preserves contracted padded replies in both caption streams", () => {
  const text = "'It was quiet.' Sí. ' I'm happy.'";
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([
      { kind, side: "A", text: "'It was quiet.'" },
      { kind, side: "B", text: "Sí." },
      { kind, side: "A", text: "' I'm happy.'" },
    ]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it("preserves a padded word quote with an external terminal in both caption streams", () => {
  const text = "'It was quiet.' Sí. ' yes'.";
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([
      { kind, side: "A", text: "'It was quiet.'" },
      { kind, side: "B", text: "Sí." },
      { kind, side: "A", text: "' yes'." },
    ]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it("keeps both marks of a nested lexical word in both caption streams", () => {
  const source = "I said 'rock 'n' roll.'", reply = "'Sí.'", text = source + " " + reply;
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: source }, { kind, side: "B", text: reply }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it("keeps a quoted-word possessive and the following reply intact in both caption streams", () => {
  const source = "I explained 'foo's meaning.", reply = "' Sí.'", text = source + " " + reply;
  for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
    const transcript = new DialogueTranscript();
    for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
    expect(content(transcript)).toEqual([{ kind, side: "A", text: source }, { kind, side: "B", text: reply }]);
    expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
  }
});

it.each(["'The dogs' owner is here.'", "'The board is 6' long.'", "'John's book is here.'"])(
  "keeps outer quotes before intervening speech in both caption streams: %s", source => {
    const unquoted = "La estación está cerca del supermercado.", reply = "' Yes.'";
    const text = source + " " + unquoted + " " + reply;
    for (const kind of ["input", "output"] as const) for (const size of [1, 1000]) {
      const transcript = new DialogueTranscript();
      for (let i = 0; i < text.length; i += size) transcript.push(kind, fragment(text.slice(i, i + size)), { A: "en", B: "es" });
      expect(content(transcript)).toEqual([
        { kind, side: "A", text: source }, { kind, side: "B", text: unquoted }, { kind, side: "A", text: reply },
      ]);
      expect(transcript.blocks.map(block => block.text).join("")).toBe(text);
    }
  });
