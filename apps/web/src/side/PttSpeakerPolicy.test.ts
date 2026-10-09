import { describe, expect, it } from "vitest";
import { PttSpeakerPolicy } from "./PttSpeakerPolicy";
import type { TranscriptFragment } from "../conversation/TranscriptFragment";

const fragment = (text: string, startMs?: number, endMs?: number): TranscriptFragment =>
  ({ id: crypto.randomUUID(), text, receivedAtMs: 999999, startMs, endMs });

describe("PTT speaker policy", () => {
  it("assigns free capture to B regardless of language, including missed VAD", () => {
    const policy = new PttSpeakerPolicy(1);
    expect(policy.assign("input", fragment("Спасибо, iPhone Pro Max, Google Maps")).side).toBe("B");
    expect(policy.assign("output", fragment("Thank you")).side).toBe("B");
  });
  it("holds the local A interval across pauses without guessing caption ownership", () => {
    const policy = new PttSpeakerPolicy(1);
    const held = policy.press(10)!;
    expect(policy.press(20)).toBeUndefined();
    policy.speech(20); policy.finish(30);
    expect(policy.held).toBe(held);
    expect(policy.assign("input", fragment("late quiet B", 200, 300)).side).toBeUndefined();
    policy.release(5000);
    expect(policy.assign("input", fragment("A or quiet new B", 400, 500)).side).toBeUndefined();
    expect(policy.held).toBeUndefined();
  });
  it("preserves already assigned B and keeps later packets uncertain across A", () => {
    const policy = new PttSpeakerPolicy(1);
    const b = policy.speech(1);
    policy.assign("input", fragment("B", 100, 500));
    policy.finish(5); policy.press(6); policy.speech(7);
    expect(b.input[0]?.text).toBe("B");
    // Approximate overlapping timestamps do not establish source ownership.
    expect(policy.assign("input", fragment("late tail", 200, 300)).side).toBeUndefined();
    expect(policy.assign("input", fragment("untimed")).side).toBeUndefined();
  });
  it.each(["AB", "BA", "AA", "BB", "ABA", "BAB"])("never pairs the latest translation in %s", sequence => {
    const policy = new PttSpeakerPolicy(4);
    for (const side of sequence) {
      if (side === "A") policy.press(0);
      policy.speech(1);
      if (side === "A") policy.release(2); else policy.finish(2);
    }
    const assignment = policy.assign("output", fragment("translation", 100, 200));
    expect(assignment.interval).toBeUndefined();
    expect(assignment.side).toBe(sequence.includes("A") ? undefined : "B");
  });
  it("a silent tap creates no speech or eligible translation", () => {
    const policy = new PttSpeakerPolicy(3);
    const held = policy.press(1)!; policy.release(2);
    expect(held.speech).toBe(false);
    expect(policy.assign("output", fragment("stray")).side).toBeUndefined();
  });
  it("deduplicates event IDs and fences old generations without removing repeated words", () => {
    const policy = new PttSpeakerPolicy(5);
    expect(policy.accept("id", 4)).toBe(false);
    expect(policy.accept("id", 5)).toBe(true);
    expect(policy.accept("id", 5)).toBe(false);
    expect(policy.accept(undefined, 5)).toBe(true);
    expect(policy.accept(undefined, 5)).toBe(true);
  });
});
