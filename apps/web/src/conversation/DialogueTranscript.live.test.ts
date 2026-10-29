import { describe, expect, it } from "vitest";
import { DialogueTranscript } from "./DialogueTranscript";
import sourceCases from "./fixtures/live-ru-es-source.json";

// Synthetic RU/ES speech captured from gpt-live-1 on 2026-10-26 and 2026-10-28; original deltas and audio timestamps.
describe("recorded unpunctuated Live source captions", () => {
  it.each(sourceCases)("keeps completed source sides throughout $name", ({ turns }) => {
    const transcript = new DialogueTranscript();
    const completed: Array<{ text: string; side: string }> = [];
    let received = "", sequence = 0;
    const checkHistory = () => {
      expect(transcript.blocks.map(block => block.text).join("")).toBe(received);
      let offset = 0;
      for (const turn of completed) {
        let position = 0;
        for (const block of transcript.blocks) {
          const overlap = block.text.slice(Math.max(0, offset - position), Math.max(0, Math.min(block.text.length, offset + turn.text.length - position)));
          if (/[\p{L}\p{N}]/u.test(overlap)) expect(block.side, turn.text).toBe(turn.side);
          position += block.text.length;
        }
        offset += turn.text.length;
      }
    };
    for (const turn of turns) {
      for (const [text, startMs, endMs] of turn.packets) {
        received += text;
        transcript.push("input", { id: String(sequence++), text: String(text), startMs: Number(startMs), endMs: Number(endMs), receivedAtMs: sequence }, { A: "ru", B: "es" });
        checkHistory();
      }
      completed.push({ text: turn.packets.map(packet => packet[0]).join(""), side: turn.side });
      checkHistory();
    }
  });

  it.each(sourceCases)("retains audio order and sides with delayed packets in $name", ({ turns }) => {
    const transcript = new DialogueTranscript();
    let sequence = 0;
    for (const turn of turns) {
      for (const [text, startMs, endMs] of [...turn.packets].reverse()) {
        transcript.push("input", { id: String(sequence++), text: String(text), startMs: Number(startMs), endMs: Number(endMs), receivedAtMs: sequence }, { A: "ru", B: "es" });
      }
    }
    expect(transcript.blocks.map(block => block.text).join("")).toBe(turns.flatMap(turn => turn.packets.map(packet => packet[0])).join(""));
    for (const side of ["A", "B"]) {
      expect(transcript.blocks.filter(block => block.side === side).map(block => block.text).join("").trim())
        .toBe(turns.filter(turn => turn.side === side).flatMap(turn => turn.packets.map(packet => packet[0])).join("").trim());
    }
  });

  it("keeps a delayed brand with its source, then accepts a separate Spanish reply", () => {
    const transcript = new DialogueTranscript();
    const languages = { A: "ru", B: "es" };
    transcript.push("input", { id: "1", text: "Я использую", startMs: 0, endMs: 1000, receivedAtMs: 1000 }, languages);
    transcript.push("input", { id: "2", text: " WhatsApp", startMs: 1000, endMs: 1500, receivedAtMs: 10000 }, languages);
    transcript.push("input", { id: "3", text: " Gracias", startMs: 8000, endMs: 8500, receivedAtMs: 11000 }, languages);
    expect(transcript.blocks.map(({ text, side }) => ({ text, side }))).toEqual([
      { text: "Я использую WhatsApp", side: "A" }, { text: " Gracias", side: "B" },
    ]);
  });

  it("keeps pauses and a split name inside the same source paragraph", () => {
    const transcript = new DialogueTranscript();
    for (const [index, text] of ["Посылка", " для", " Мих", "аила"].entries()) {
      transcript.push("input", { id: String(index), text, startMs: index * 2000, endMs: index * 2000 + 200, receivedAtMs: index }, { A: "ru", B: "es" });
    }
    expect(transcript.blocks.map(({ text, side }) => ({ text, side }))).toEqual([{ text: "Посылка для Михаила", side: "A" }]);
  });

  it.each([
    { parts: ["Приедем в пятницу, ", "23", " числа"], side: "A" },
    { parts: ["Llegaremos el día ", "23", " de octubre"], side: "B" },
    { parts: ["Это стоит ", "23", ", ", "50 €", " за человека"], side: "A" },
    { parts: ["23", " числа"], side: "A" },
    { parts: ["23", " euros por persona"], side: "B" },
  ])("retains neutral fragments across audio pauses: $parts", ({ parts, side }) => {
    for (const reverse of [false, true]) {
      const transcript = new DialogueTranscript();
      const packets = parts.map((text, index) => ({ id: String(index), text, startMs: index * 1000, endMs: index * 1000 + 200, receivedAtMs: index }));
      for (const [index, packet] of (reverse ? packets.reverse() : packets).entries()) {
        transcript.push("input", { ...packet, receivedAtMs: index }, { A: "ru", B: "es" });
      }
      expect(transcript.blocks.map(({ text, side }) => ({ text, side }))).toEqual([{ text: parts.join(""), side }]);
    }
  });

  it.each([
    { text: "23", after: " euros por persona", side: "B" },
    { text: "Γειά σας", after: " euros por persona", side: "B" },
    { text: "Γειά σας", after: " числа", side: "A" },
  ])("does not infer a side without agreeing language context: $text / $after", ({ text, after, side }) => {
    const transcript = new DialogueTranscript();
    for (const [index, part] of ["Приедем в пятницу, ", text, after].entries()) {
      transcript.push("input", { id: String(index), text: part, startMs: index * 1000, endMs: index * 1000 + 200, receivedAtMs: index }, { A: "ru", B: "es" });
    }
    expect(transcript.blocks.map(({ text, side }) => ({ text, side }))).toEqual([
      { text: "Приедем в пятницу, ", side: "A" },
      { text, side: undefined },
      { text: after, side },
    ]);
  });
});
