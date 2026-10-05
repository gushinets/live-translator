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
