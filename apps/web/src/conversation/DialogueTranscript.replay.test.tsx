import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DialogueCaptions } from "../components/DialogueCaptions";
import { DialogueTranscript } from "./DialogueTranscript";
import cases from "./fixtures/live-ru-es-captions.json";

// Real gpt-live-1 packets and journal projections, 2026-10-29 after-mic-fix acceptance.
// Expected panes preserve every character; only the eight reviewed unassigned spans are repaired.
describe("recorded RU/ES caption assembly", () => {
  it.each(cases.flatMap(record => [false, true].map(delayed => ({ ...record, delayed }))))("retains full text, sides and authors: $name, delayed=$delayed", record => {
    const transcript = new DialogueTranscript();
    const languages = { A: "ru", B: "es" };
    for (const part of record.delayed ? [...record.input].reverse() : record.input) transcript.push("input", part, languages);
    const outputs = structuredClone(record.outputs);
    // Replay each packet at its journal boundary, including incomplete words and numbers.
    const packets = outputs.flatMap(output => output.fragments.map(part => ({ output, part })))
      .sort((a, b) => a.part.receivedAtMs - b.part.receivedAtMs);
    const projection = new Map<string, typeof outputs[number]>();
    for (const { output, part } of record.delayed ? packets.reverse() : packets) {
      const current = projection.get(output.id) ?? { ...output, fragments: [] };
      current.fragments.push(part);
      projection.set(output.id, current);
      transcript.setOutputs([...projection.values()], languages);
    }
    const check = () => {
      for (const kind of ["input", "output"] as const) for (const side of ["A", "B"] as const) {
        expect(transcript.blocks.filter(block => block.kind === kind && block.side === side).map(block => block.text).join(""), `${kind}/${side}`)
          .toBe(record.expected[kind][side]);
      }
      expect(transcript.blocks.filter(block => block.side === undefined && block.text.trim())).toEqual([]);
      for (const side of ["A", "B"] as const) {
        const blocks = transcript.blocks.filter(block => block.side === side && block.text.trim());
        const root = document.createElement("div");
        root.innerHTML = renderToStaticMarkup(createElement(DialogueCaptions, { blocks, language: languages[side] }));
        expect([...root.querySelectorAll(".turn-author")].map(node => node.textContent))
          .toEqual(blocks.map(block => side === "A" ? block.kind === "input" ? "Я: " : "Он: " : block.kind === "input" ? "Yo: " : "Él: "));
        expect([...root.querySelectorAll(".recent-turn-primary")].map(node => node.textContent)).toEqual(blocks.map(block => block.text.trim()));
      }
    };
    check();
    // Source ownership revisions must not move text or lose its localized author label.
    transcript.setOutputs(outputs.map(output => ({ ...output, sourceId: undefined })), languages);
    check();
    transcript.seal();
    check();
    expect(outputs).toEqual(record.outputs);
  });
});

it.each([
  { parts: ["¿Y podría ser", " sin", " leche?"], text: "¿Y podría ser sin leche?", side: "B" },
  { parts: ["Вы хотите газирован", "ную", " воду?"], text: "Вы хотите газированную воду?", side: "A" },
  { parts: ["Llegaremos el viernes ", "23."], text: "Llegaremos el viernes 23.", side: "B" },
  { parts: ["No, el seguro de", " 200", " euros."], text: "No, el seguro de 200 euros.", side: "B" },
])("assembles one signed row across journal splits: $text", ({ parts, text, side }) => {
  const transcript = new DialogueTranscript();
  transcript.setOutputs(parts.map((text, index) => ({ id: String(index), sourceId: index === 0 ? "source" : undefined,
    fragments: [{ id: String(index), text, startMs: index * 1000, endMs: index * 1000 + 200, receivedAtMs: index * 5000 }] })), { A: "ru", B: "es" });
  expect(transcript.blocks).toEqual([expect.objectContaining({ text, side, attribution: "unattributed" })]);
});

it("does not assign an isolated number after a complete source sentence or cross a lifecycle boundary", () => {
  const transcript = new DialogueTranscript(), languages = { A: "ru", B: "es" };
  transcript.push("input", { id: "1", text: "До встречи.", startMs: 0, endMs: 200, receivedAtMs: 0 }, languages);
  transcript.push("input", { id: "2", text: " 41", startMs: 2000, endMs: 2200, receivedAtMs: 1 }, languages);
  expect(transcript.blocks.at(-1)).toMatchObject({ text: " 41", side: undefined });
  transcript.setOutputs([{ id: "old", fragments: [{ id: "3", text: "El precio es ", startMs: 0, endMs: 200, receivedAtMs: 2 }] }], languages);
  transcript.seal();
  transcript.setOutputs([{ id: "new", fragments: [{ id: "4", text: "200", startMs: 1000, endMs: 1200, receivedAtMs: 3 }] }], languages);
  expect(transcript.blocks.at(-1)).toMatchObject({ text: "200", side: undefined });
});
