import { expect, it } from "vitest";
import { splitSentences } from "./sentenceBoundaries";
import { eld } from "eld/extrasmall";
import { splitLanguageSentences } from "./languageScripts";

it.each([
  { text: '3.14 liters. 1.5 kilograms.', expected: ['3.14 liters. ', '1.5 kilograms.'] },
  { text: 'He is 6\'2". "Sí."', expected: ['He is 6\'2". ', '"Sí."'] },
  { text: 'He said "123". "Sí."', expected: ['He said "123". ', '"Sí."'] },
])("preserves decimal values and quotation boundaries: $text", ({ text, expected }) => {
  expect(splitSentences(text)).toEqual(expected);
});

it("preserves a long unfinished transcript after a complete sentence", () => {
  const tail = "a".repeat(40000);
  expect(splitSentences("Hello. " + tail)).toEqual(["Hello. ", tail]);
  expect(splitSentences(tail)).toEqual([tail]);
});


it.each([
  { text: '"He is 6\'2" tall." "Sí."', expected: ['"He is 6\'2" tall." ', '"Sí."'] },
  { text: "'The dogs' owner is here.' 'Sí.'", expected: ["'The dogs' owner is here.' ", "'Sí.'"] },
  { text: "'Dogs' owner is here. 'Sí.'", expected: ["'Dogs' owner is here. ", "'Sí.'"] },
])("preserves outer quote ownership: $text", ({ text, expected }) => {
  expect(splitSentences(text)).toEqual(expected);
});


it.each(["Dogs", "Big dogs"])("preserves adjacent quoted replies after a quoted noun: %s", noun => {
  expect(splitSentences("'" + noun + "' owner is here.'Sí.'")).toEqual(["'" + noun + "' owner is here.", "'Sí.'"]);
});

it("keeps a long weak prefix separate from a decisive reply", () => {
  const prefix = "123. ".repeat(400);
  expect(splitLanguageSentences(prefix + "Sí.", { A: "en", B: "es" }, eld.newInstance())).toEqual([prefix, "Sí."]);
  expect(splitLanguageSentences("5. Oktober. Да.", { A: "ru", B: "de" }, eld.newInstance())).toEqual(["5. Oktober. ", "Да."]);
  expect(splitLanguageSentences("Dr. Ј. Петровић.", { A: "en", B: "sr" }, eld.newInstance())).toEqual(["Dr. Ј. Петровић."]);
});

it.each([
  { text: '"It is 12" long."', expected: ['"It is 12" long."'] },
  { text: "'The board is 6' long.'", expected: ["'The board is 6' long.'"] },
  { text: 'He said "123" and left. "Sí."', expected: ['He said "123" and left. ', '"Sí."'] },
])("preserves standalone measurements and numeric quotations: $text", ({ text, expected }) => {
  expect(splitSentences(text)).toEqual(expected);
});

it.each(['"2 personas están aquí."', '"¿Dónde está la estación?"', '"(2 personas están aquí.)"'])("keeps a numeric quotation separate from the next quoted reply: %s", reply => {
  const source = 'He said "123" and left.';
  expect(splitSentences(source + reply)).toEqual([source, reply]);
});

it.each(["\"It is 12\", not 10.\"","\"The board is 12\".\"","'It is 6', not 5.'","\"The board is 12\" x 6\" long.\"","'The dogs' collars and cats' toys are here.'"])("preserves outer quotes across multiple and punctuated inner marks: %s", source => {
  const reply = '"Sí."';
  expect(splitSentences(source + " " + reply)).toEqual([source + " ", reply]);
});

it("bounds repeated measurement lookahead in a long outer quote", () => {
  const source = '"It is ' + '12", '.repeat(12000) + 'long."', reply = '"Sí."';
  const start = performance.now();
  const sentences = splitSentences(source + " " + reply);
  const elapsed = performance.now() - start;
  expect(sentences).toEqual([source + " ", reply]);
  expect(elapsed).toBeLessThan(1000);
});

it.each(["I loved the '90s.","I left 'cause it was late.","I looked 'round.","I asked 'bout."])("keeps leading lexical apostrophes outside quote state: %s", source => {
  expect(splitSentences(source + " 'Sí.'")).toEqual([source + " ", "'Sí.'"]);
});

it.each(['"La estación está cerca del supermercado', '"La estación está cerca del supermercado"'])("preserves an unpunctuated quoted tail after numeric quotation: %s", reply => {
  for (const number of ["123", "12.3", "-123"]) {
    const source = 'He said "' + number + '" and left.';
    expect(splitSentences(source + reply)).toEqual([source, reply]);
  }
});

it.each(["He said '90s' and left.", "'90s were great.'", "'cause it was late.'", "'I left 'cause it was late.'", "He said 'round' and left.", "'round here is quiet.'", "'I looked 'round.'"])("preserves real single quotes around elision-shaped words: %s", source => {
  expect(splitSentences(source + " 'Sí.'")).toEqual([source + " ", "'Sí.'"]);
});

it.each(["'90s were great. Music was better.'", "'cause it was late. I left early.'", "'cause I don't know. I left early.'", "'cause 'twas late. I left early.'"])("preserves lexical-shaped openers across multiple quoted sentences: %s", source => {
  const sentences = splitSentences(source + " 'Sí.'");
  expect(sentences.at(-1)).toBe("'Sí.'");
  expect(sentences.slice(0, -1).join("")).toBe(source + " ");
});

it.each(["Veuillez ouvrir le site example.no.", 'Veuillez ouvrir le site "example.no".'])("keeps a canonical reply inside a contiguous hostname: %s", text => {
  expect(splitLanguageSentences(text, { A: "en", B: "fr" }, eld.newInstance())).toEqual([text]);
});

it.each(["I stayed 'cept.", "I waited 'neath.", "I said 'scuse.", "I waited 'nęath.", "I left 'Cause it was late.", "I stayed 'CEPT.", "I looked 'Round.", "I loved the '90S.", "'Cause it was late."])("keeps unlisted leading elisions separate from quoted replies: %s", source => {
  for (const reply of ["'Sí.'", "'sí.'", "'oui.'"]) {
    expect(splitSentences(source + " " + reply)).toEqual([source + " ", reply]);
  }
});

it.each([
  "He said 'cept' and left.",
  "'neath the bridge. I waited.'",
  "'I stayed 'cept. I waited 'neath the bridge.'",
  "'cept 'scuse was too short. I left early.'",
  "'sí.'",
  "He said 'YES' and left.",
  "'Cause it was late. I left early.'",
])("preserves paired quotes around elision-shaped words: %s", source => {
  const sentences = splitSentences(source + " 'oui.'");
  expect(sentences.at(-1)).toBe("'oui.'");
  expect(sentences.slice(0, -1).join("")).toBe(source + " ");
});

it("bounds lookahead through repeated unlisted elisions", () => {
  const source = "'I stayed " + "'cept ".repeat(12000) + "until morning.'", reply = "'sí.'";
  const start = performance.now();
  expect(splitSentences(source + " " + reply)).toEqual([source + " ", reply]);
  expect(performance.now() - start).toBeLessThan(1000);
});


it("distinguishes adjacent terminal closers from quoted reply openers", () => {
  expect(splitSentences("'The dogs' owner is here.'La estación está cerca."))
    .toEqual(["'The dogs' owner is here.'", "La estación está cerca."]);
  expect(splitSentences("I stayed 'cept.'sí.'"))
    .toEqual(["I stayed 'cept.", "'sí.'"]);
  expect(splitSentences("I stayed 'cept.'yes' then left."))
    .toEqual(["I stayed 'cept.", "'yes' then left."]);
});

it("keeps a quoted reply's leading space after an adjacent source terminal", () => {
  expect(splitSentences("I stayed 'cept.' sí.'")).toEqual(["I stayed 'cept.", "' sí.'"]);
  expect(splitSentences("'It was quiet.' Unquoted text. 'Sí.'"))
    .toEqual(["'It was quiet.' ", "Unquoted text. ", "'Sí.'"]);
  expect(splitSentences("'It was quiet.' ' Sí.'"))
    .toEqual(["'It was quiet.' ", "' Sí.'"]);
});

it.each([
  { text: "'It was quiet.' Unquoted text. ' Sí.'", expected: ["'It was quiet.' ", "Unquoted text. ", "' Sí.'"] },
  { text: "'It was quiet.' Sí. ' sí.'", expected: ["'It was quiet.' ", "Sí. ", "' sí.'"] },
  { text: "'It was quiet.' Sí.' sí.'", expected: ["'It was quiet.' ", "Sí.", "' sí.'"] },
  { text: "'It was quiet.'Sí.' sí.'", expected: ["'It was quiet.'", "Sí.", "' sí.'"] },
])("keeps a real closer before unquoted speech and a padded quoted reply: $text", ({ text, expected }) => {
  expect(splitSentences(text)).toEqual(expected);
});

it("keeps an actual reply mate before later unquoted and quoted text", () => {
  expect(splitSentences("I stayed 'cept.'sí.' Unquoted text. ' oui.'"))
    .toEqual(["I stayed 'cept.", "'sí.' ", "Unquoted text. ", "' oui.'"]);
});

it.each([
  { text: "'It was quiet.' Sí. ' I'm happy.'", expected: ["'It was quiet.' ", "Sí. ", "' I'm happy.'"] },
  { text: "'It was quiet.' Unquoted text. ' Don't go.'", expected: ["'It was quiet.' ", "Unquoted text. ", "' Don't go.'"] },
  { text: "'It was quiet.' Unquoted text. ' I left 'cause it was late.'", expected: ["'It was quiet.' ", "Unquoted text. ", "' I left 'cause it was late.'"] },
  { text: "I stayed 'cept.' I'm happy.'", expected: ["I stayed 'cept.", "' I'm happy.'"] },
  { text: "'It was quiet.' Sí. ' The dogs' owner is here.'", expected: ["'It was quiet.' ", "Sí. ", "' The dogs' owner is here.'"] },
  { text: "'It was quiet.' Sí. ' The board is 6' long.'", expected: ["'It was quiet.' ", "Sí. ", "' The board is 6' long.'"] },
])("skips lexical apostrophes while finding a padded reply's mate: $text", ({ text, expected }) => {
  expect(splitSentences(text)).toEqual(expected);
});

it.each(["yes", "oui", "90", "two words", "I'm happy"])("keeps an earlier closer before a padded word quote with an external terminal: %s", word => {
  expect(splitSentences("'It was quiet.' Sí. ' " + word + "'."))
    .toEqual(["'It was quiet.' ", "Sí. ", "' " + word + "'."]);
});

it.each(["I said 'rock 'n' roll.'", "I loved 'the '90s' music.'"])("keeps paired lexical words inside an outer quote: %s", source => {
  expect(splitSentences(source + " 'Sí.'")).toEqual([source + " ", "'Sí.'"]);
});

it.each([
  "I explained 'foo's meaning.",
  "I explained 'notes's meaning.",
  "I explained 'café's meaning.",
  "He said 'It's quiet.'",
  "He said 'John's happy. He is here.'",
  "He said 'It's quiet. Don't go.'",
])("keeps a quoted-word possessive distinct from contractions: %s", source => {
  for (const gap of [" ", ""]) {
    const sentences = splitSentences(source + gap + "' Sí.'");
    expect(sentences.at(-1)).toBe("' Sí.'");
    expect(sentences.slice(0, -1).join("")).toBe(source + gap);
  }
});
