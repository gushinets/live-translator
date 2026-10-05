import { expect, it } from "vitest";
import { orderTranscriptFragments, type TranscriptFragment } from "./TranscriptFragment";
const packet = (text: string, startMs?: number): TranscriptFragment => ({ id: text, text, receivedAtMs: 0, startMs });
it("keeps known timestamp order after untimed tails and further late packets", () => {
  const parts = [packet("name", 1000), packet("prefix ", 0), packet("."), packet(" middle ", 500), packet("Next.", 2000)];
  const ordered = orderTranscriptFragments(parts);
  expect(ordered.map(part => part.text)).toEqual(["prefix ", " middle ", "name", ".", "Next."]);
  expect(parts.map(part => part.text)).toEqual(["name", "prefix ", ".", " middle ", "Next."]);
  expect(orderTranscriptFragments(ordered)).toEqual(ordered);
});
it("preserves untimed openings, equal timestamp order and entirely untimed speech", () => {
  const parts = [packet("12, "), packet("first", 0), packet(" second", 0), packet(".")];
  expect(orderTranscriptFragments(parts)).toEqual(parts);
  const untimed = [packet("hello"), packet(" world")];
  expect(orderTranscriptFragments(untimed)).toEqual(untimed);
});
