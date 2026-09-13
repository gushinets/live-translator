import { describe, expect, it } from "vitest";
import type { TranscriptFragment } from "./TranscriptFragment";
import type { Turn } from "./Turn";
import {
  TurnBuffer,
  clearSourceIdle,
  createTurn,
  markAudioOutputStarted,
  markPlaybackEnded,
  startFreshOutputEpoch,
} from "./TurnBuffer";

function fragment(text: string, nowMs: number): TranscriptFragment {
  return { id: `frag-${nowMs}`, text, receivedAtMs: nowMs };
}

describe("TurnBuffer.start", () => {
  it("creates a streaming turn with no output yet", () => {
    const buffer = new TurnBuffer();
    const turn = buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });

    expect(turn.id).toBe("t1");
    expect(turn.speaker).toBe("A");
    expect(turn.sideSource).toBe("prior");
    expect(turn.status).toBe("streaming");
    expect(turn.corrected).toBe(false);
    expect(turn.audioOutputStarted).toBe(false);
    expect(turn.sourceFragments).toEqual([]);
    expect(turn.originalText).toBe("");
    expect(turn.speechStartAtMs).toBe(1000);
  });

  it("fails if a second active turn is started before the previous is closed", () => {
    const buffer = new TurnBuffer();
    buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });

    expect(() =>
      buffer.start({ id: "t2", speaker: "B", sideSource: "prior", nowMs: 1100 }),
    ).toThrow(/previous active turn/i);
  });
});

describe("TurnBuffer.appendSourceFragment", () => {
  it("accumulates fragments and original text on the active turn", () => {
    const buffer = new TurnBuffer();
    buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });

    buffer.appendSourceFragment(fragment("Hello ", 1010));
    const turn = buffer.appendSourceFragment(fragment("world", 1020));

    expect(turn.sourceFragments).toHaveLength(2);
    expect(turn.originalText).toBe("Hello world");
  });

  it("fails when there is no active turn", () => {
    const buffer = new TurnBuffer();
    expect(() => buffer.appendSourceFragment(fragment("hi", 1000))).toThrow(/no active turn/i);
  });
});

describe("TurnBuffer.appendOutputText", () => {
  it("moves the turn to outputting and records first-output timing", () => {
    const buffer = new TurnBuffer();
    buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });

    const turn = buffer.appendOutputText("Hola", 1500);

    expect(turn.status).toBe("outputting");
    expect(turn.translatedText).toBe("Hola");
    expect(turn.firstOutputTextAtMs).toBe(1500);
    expect(turn.outputTextEndAtMs).toBe(1500);
  });

  it("accumulates further output deltas without resetting firstOutputTextAtMs", () => {
    const buffer = new TurnBuffer();
    buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });
    buffer.appendOutputText("Hola", 1500);
    const turn = buffer.appendOutputText(" mundo", 1600);

    expect(turn.translatedText).toBe("Hola mundo");
    expect(turn.firstOutputTextAtMs).toBe(1500);
    expect(turn.outputTextEndAtMs).toBe(1600);
  });
});

describe("TurnBuffer.complete / fail / discard", () => {
  it("completes the active turn, moves it into recent, and clears active", () => {
    const buffer = new TurnBuffer();
    buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });

    const completed = buffer.complete(2000);

    expect(completed.status).toBe("completed");
    expect(completed.turnCompletedAtMs).toBe(2000);
    expect(buffer.recent()).toEqual([completed]);
    expect(() => buffer.appendSourceFragment(fragment("x", 2001))).toThrow(/no active turn/i);
  });

  it("keeps at most 3 recent completed turns", () => {
    const buffer = new TurnBuffer();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = `t${i}`;
      buffer.start({ id, speaker: i % 2 === 0 ? "A" : "B", sideSource: "prior", nowMs: i * 100 });
      buffer.complete(i * 100 + 50);
      ids.push(id);
    }

    const recentIds = buffer.recent().map((turn) => turn.id);
    expect(recentIds).toEqual(["t1", "t2", "t3"]);
  });

  it("fails the active turn and moves it into recent as failed", () => {
    const buffer = new TurnBuffer();
    buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });

    const failed = buffer.fail(2000);

    expect(failed.status).toBe("failed");
    expect(buffer.recent()).toEqual([failed]);
  });

  it("discards the active turn and moves it into recent as discarded", () => {
    const buffer = new TurnBuffer();
    buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });

    const discarded = buffer.discard(2000);

    expect(discarded.status).toBe("discarded");
    expect(buffer.recent()).toEqual([discarded]);
  });

  it("allows starting a new turn again after the previous one is closed", () => {
    const buffer = new TurnBuffer();
    buffer.start({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });
    buffer.complete(1100);

    const turn2 = buffer.start({ id: "t2", speaker: "B", sideSource: "prior", nowMs: 1200 });
    expect(turn2.id).toBe("t2");
  });
});

describe("clearSourceIdle", () => {
  it("removes sourceIdleAtMs so a continued utterance is not latched idle", () => {
    const turn: Turn = {
      ...createTurn({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 }),
      sourceIdleAtMs: 1200,
    };
    expect(clearSourceIdle(turn).sourceIdleAtMs).toBeUndefined();
  });
});

describe("startFreshOutputEpoch", () => {
  it("clears stale output-epoch fields and marks the turn corrected", () => {
    const turn: Turn = {
      ...createTurn({ id: "t1", speaker: "B", sideSource: "prior", nowMs: 1000 }),
      status: "correcting",
      translatedText: "Hola",
      firstOutputTextAtMs: 1500,
      outputTextEndAtMs: 1800,
      audioOutputStarted: true,
      firstAudibleOutputAtMs: 1600,
      playbackEndAtMs: 2000,
    };
    const next = startFreshOutputEpoch(turn, "A");

    expect(next.speaker).toBe("A");
    expect(next.sideSource).toBe("manual");
    expect(next.corrected).toBe(true);
    expect(next.status).toBe("outputting");
    expect(next.translatedText).toBeUndefined();
    expect(next.firstOutputTextAtMs).toBeUndefined();
    expect(next.outputTextEndAtMs).toBeUndefined();
    expect(next.audioOutputStarted).toBe(false);
    expect(next.firstAudibleOutputAtMs).toBeUndefined();
    expect(next.playbackEndAtMs).toBeUndefined();
  });
});

describe("markAudioOutputStarted / markPlaybackEnded", () => {
  it("records first audible output once", () => {
    const turn = createTurn({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });
    const started = markAudioOutputStarted(turn, 1600);
    const again = markAudioOutputStarted(started, 1700);

    expect(started.audioOutputStarted).toBe(true);
    expect(started.firstAudibleOutputAtMs).toBe(1600);
    expect(again.firstAudibleOutputAtMs).toBe(1600);
  });

  it("records playbackEndAtMs", () => {
    const turn = createTurn({ id: "t1", speaker: "A", sideSource: "prior", nowMs: 1000 });
    expect(markPlaybackEnded(turn, 2100).playbackEndAtMs).toBe(2100);
  });
});
