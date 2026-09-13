import { describe, expect, it } from "vitest";
import type { ParticipantProfile } from "../conversation/ParticipantProfile";
import type { Side, Turn } from "../conversation/Turn";
import { createTurn } from "../conversation/TurnBuffer";
import { sessionReducer } from "./sessionReducer";
import { createInitialSession, type TranslationSession } from "./SessionState";

function participant(side: Side): ParticipantProfile {
  return { side, hasAcceptedConversationSpeech: false };
}

function baseSession(): TranslationSession {
  return createInitialSession(participant("A"), participant("B"));
}

/** A session already in `listening`, optionally with an active source turn. */
function listeningState(options: {
  expectedSpeaker: Side;
  sourceActive: boolean;
  speaker?: Side;
}): TranslationSession {
  const speaker = options.speaker ?? options.expectedSpeaker;
  const activeTurn: Turn | undefined = options.sourceActive
    ? createTurn({ id: "active-turn", speaker, sideSource: "prior", nowMs: 1000 })
    : undefined;
  return {
    ...baseSession(),
    state: "listening",
    expectedSpeaker: options.expectedSpeaker,
    activeTurn,
  };
}

/** A session in `outputting` with an active turn from `speaker`, ready to close. */
function stateWithCompletedTurn(speaker: Side): TranslationSession {
  const activeTurn: Turn = {
    ...createTurn({ id: "active-turn", speaker, sideSource: "prior", nowMs: 1000 }),
    status: "outputting",
    sourceIdleAtMs: 1200,
  };
  return {
    ...baseSession(),
    state: "outputting",
    expectedSpeaker: speaker,
    activeTurn,
  };
}

/** Outputting session whose active turn already has a stale output epoch. */
function outputtingStateWithStaleEpoch(speaker: Side): TranslationSession {
  const base = stateWithCompletedTurn(speaker);
  const activeTurn = base.activeTurn;
  if (activeTurn === undefined) {
    throw new Error("outputtingStateWithStaleEpoch requires an active turn.");
  }
  return {
    ...base,
    activeTurn: {
      ...activeTurn,
      translatedText: "Hola",
      firstOutputTextAtMs: 1500,
      outputTextEndAtMs: 1800,
      audioOutputStarted: true,
      firstAudibleOutputAtMs: 1600,
      playbackEndAtMs: 2000,
    },
  };
}

const SOURCE_APPEND_BLOCKED_STATES = ["correcting", "ending", "ended", "error", "suspended"] as const;

describe("sessionReducer: OUTPUT_IDLE never changes expectedSpeaker or state", () => {
  it("does not change expected speaker when output ends before source idle", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: true });
    const next = sessionReducer(state, { type: "OUTPUT_IDLE" });
    expect(next.expectedSpeaker).toBe("A");
    expect(next.state).toBe("listening");
  });

  it("does not change expectedSpeaker when OUTPUT_IDLE arrives with no active turn", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: false });
    const next = sessionReducer(state, { type: "OUTPUT_IDLE" });
    expect(next.expectedSpeaker).toBe("A");
    expect(next.state).toBe("listening");
    expect(next).toBe(state);
  });
});

describe("sessionReducer: expectedSpeaker changes only after TURN_CLOSED", () => {
  it("changes expected speaker only after a completed source turn", () => {
    const next = sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_CLOSED", speaker: "A" });
    expect(next.expectedSpeaker).toBe("B");
  });

  it("moves the closed turn into recentTurns as completed and clears activeTurn", () => {
    const next = sessionReducer(stateWithCompletedTurn("B"), { type: "TURN_CLOSED", speaker: "B" });
    expect(next.activeTurn).toBeUndefined();
    expect(next.recentTurns).toHaveLength(1);
    expect(next.recentTurns[0]?.status).toBe("completed");
    expect(next.lastSpeaker).toBe("B");
  });

  it("returns to listening after a turn closes", () => {
    const next = sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_CLOSED", speaker: "A" });
    expect(next.state).toBe("listening");
  });

  it("throws if the closed speaker does not match the active turn's speaker", () => {
    expect(() =>
      sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_CLOSED", speaker: "B" }),
    ).toThrow(/does not match/i);
  });

  it("throws if TURN_CLOSED arrives with no active turn", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: false });
    expect(() => sessionReducer(state, { type: "TURN_CLOSED", speaker: "A" })).toThrow(/no active turn/i);
  });
});

describe("sessionReducer: main conversation flow", () => {
  it("SOURCE_ACTIVE starts a fresh turn while listening with no active turn", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: false });
    const next = sessionReducer(state, {
      type: "SOURCE_ACTIVE",
      turnId: "t1",
      speaker: "A",
      sideSource: "prior",
    });
    expect(next.activeTurn?.id).toBe("t1");
    expect(next.activeTurn?.status).toBe("streaming");
    expect(next.state).toBe("listening");
  });

  it("SOURCE_ACTIVE for the same speaker continues the existing active turn", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, {
      type: "SOURCE_ACTIVE",
      turnId: "active-turn",
      speaker: "A",
      sideSource: "prior",
      fragment: { id: "f1", text: "hola", receivedAtMs: 1050 },
    });
    expect(next.activeTurn?.originalText).toBe("hola");
  });

  it("clears sourceIdleAtMs when the same speaker continues after a premature idle", () => {
    const idle = sessionReducer(
      listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" }),
      { type: "SOURCE_IDLE" },
    );
    expect(idle.activeTurn?.sourceIdleAtMs).toBeDefined();

    const next = sessionReducer(idle, {
      type: "SOURCE_ACTIVE",
      turnId: "active-turn",
      speaker: "A",
      sideSource: "prior",
    });
    expect(next.activeTurn?.sourceIdleAtMs).toBeUndefined();
    expect(next.activeTurn?.id).toBe("active-turn");
  });

  it("does not throw or change expectedSpeaker when SOURCE_IDLE arrives with no active turn", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: false });
    const next = sessionReducer(state, { type: "SOURCE_IDLE" });
    expect(next.expectedSpeaker).toBe("A");
    expect(next.state).toBe("listening");
    expect(next).toBe(state);
  });

  it.each(SOURCE_APPEND_BLOCKED_STATES)("rejects SOURCE_ACTIVE while session state is %s", (blockedState) => {
    const state: TranslationSession = {
      ...listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" }),
      state: blockedState,
    };
    expect(() =>
      sessionReducer(state, {
        type: "SOURCE_ACTIVE",
        turnId: "active-turn",
        speaker: "A",
        sideSource: "prior",
      }),
    ).toThrow(new RegExp(blockedState));
  });

  it.each(SOURCE_APPEND_BLOCKED_STATES)("rejects SOURCE_FRAGMENT while session state is %s", (blockedState) => {
    const state: TranslationSession = {
      ...listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" }),
      state: blockedState,
    };
    expect(() =>
      sessionReducer(state, {
        type: "SOURCE_FRAGMENT",
        fragment: { id: "f-blocked", text: "nope", receivedAtMs: 1100 },
      }),
    ).toThrow(new RegExp(blockedState));
  });

  it("fails fast (overlap guard) if a second active turn starts for a different speaker", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" });
    expect(() =>
      sessionReducer(state, { type: "SOURCE_ACTIVE", turnId: "t2", speaker: "B", sideSource: "prior" }),
    ).toThrow(/has not been closed/i);
  });

  it("OUTPUT_ACTIVE moves listening to outputting and marks the turn outputting", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, { type: "OUTPUT_ACTIVE" });
    expect(next.state).toBe("outputting");
    expect(next.activeTurn?.status).toBe("outputting");
  });

  it("SOURCE_IDLE records sourceIdleAtMs without changing state or expectedSpeaker", () => {
    const state = stateWithCompletedTurn("A");
    const next = sessionReducer(state, { type: "SOURCE_IDLE" });
    expect(next.activeTurn?.sourceIdleAtMs).toBeDefined();
    expect(next.state).toBe("outputting");
    expect(next.expectedSpeaker).toBe("A");
  });

  it("TURN_FAILED keeps expectedSpeaker on the same source side (§10.3)", () => {
    const state = stateWithCompletedTurn("A");
    const next = sessionReducer(state, { type: "TURN_FAILED" });
    expect(next.expectedSpeaker).toBe("A");
    expect(next.state).toBe("listening");
    expect(next.recentTurns[0]?.status).toBe("failed");
    expect(next.activeTurn).toBeUndefined();
  });
});

describe("sessionReducer: correction flow (§11.2)", () => {
  it("moves outputting -> correcting on CORRECTION_START", () => {
    const state = stateWithCompletedTurn("A");
    const next = sessionReducer(state, { type: "CORRECTION_START" });
    expect(next.state).toBe("correcting");
    expect(next.activeTurn?.status).toBe("correcting");
  });

  it("throws if there is no correctable turn", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: false });
    expect(() => sessionReducer(state, { type: "CORRECTION_START" })).toThrow(/no correctable turn/i);
  });

  it("throws if CORRECTION_START arrives while listening to a streaming active turn", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" });
    expect(state.state).toBe("listening");
    expect(state.activeTurn?.status).toBe("streaming");
    expect(() => sessionReducer(state, { type: "CORRECTION_START" })).toThrow();
  });

  it("promotes a completed latest turn onto activeTurn as correcting", () => {
    const closed = sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_CLOSED", speaker: "A" });
    expect(closed.activeTurn).toBeUndefined();
    expect(closed.recentTurns[0]?.status).toBe("completed");

    const next = sessionReducer(closed, { type: "CORRECTION_START" });
    expect(next.state).toBe("correcting");
    expect(next.activeTurn?.id).toBe("active-turn");
    expect(next.activeTurn?.status).toBe("correcting");
    expect(next.recentTurns).toEqual([]);
  });

  it("does not rehydrate a failed latest turn from recentTurns", () => {
    const failed = sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_FAILED" });
    expect(failed.recentTurns[0]?.status).toBe("failed");
    expect(() => sessionReducer(failed, { type: "CORRECTION_START" })).toThrow(/no correctable turn/i);
  });

  it("does not rehydrate a discarded latest turn from recentTurns", () => {
    const suspended = sessionReducer(
      listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" }),
      { type: "SUSPEND" },
    );
    const resumed = sessionReducer(suspended, { type: "RESUME" });
    expect(resumed.recentTurns[0]?.status).toBe("discarded");
    expect(() => sessionReducer(resumed, { type: "CORRECTION_START" })).toThrow(/no correctable turn/i);
  });

  it("does not skip a failed latest turn to an older completed turn", () => {
    const closed = sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_CLOSED", speaker: "A" });
    const failed = sessionReducer(stateWithCompletedTurn("B"), { type: "TURN_FAILED" });
    const mixed: TranslationSession = {
      ...failed,
      recentTurns: [...closed.recentTurns, ...failed.recentTurns],
    };
    expect(mixed.recentTurns.map((turn) => turn.status)).toEqual(["completed", "failed"]);
    expect(() => sessionReducer(mixed, { type: "CORRECTION_START" })).toThrow(/no correctable turn/i);
  });

  it("reassigns speaker and marks the turn corrected", () => {
    const correcting = sessionReducer(stateWithCompletedTurn("B"), { type: "CORRECTION_START" });
    const next = sessionReducer(correcting, { type: "CORRECTION_APPLIED", speaker: "A" });

    expect(next.state).toBe("outputting");
    expect(next.activeTurn?.speaker).toBe("A");
    expect(next.activeTurn?.corrected).toBe(true);
    expect(next.activeTurn?.sideSource).toBe("manual");
  });

  it("starts a fresh output epoch", () => {
    const correcting = sessionReducer(outputtingStateWithStaleEpoch("B"), { type: "CORRECTION_START" });
    const next = sessionReducer(correcting, { type: "CORRECTION_APPLIED", speaker: "A" });

    expect(next.activeTurn?.translatedText).toBeUndefined();
    expect(next.activeTurn?.firstOutputTextAtMs).toBeUndefined();
    expect(next.activeTurn?.outputTextEndAtMs).toBeUndefined();
    expect(next.activeTurn?.audioOutputStarted).toBe(false);
    expect(next.activeTurn?.firstAudibleOutputAtMs).toBeUndefined();
    expect(next.activeTurn?.playbackEndAtMs).toBeUndefined();
  });
});

describe("sessionReducer: output epoch actions", () => {
  it("OUTPUT_DELTA appends text through the turn helper and moves listening to outputting", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, { type: "OUTPUT_DELTA", text: "Hola", nowMs: 1500 });

    expect(next.state).toBe("outputting");
    expect(next.activeTurn?.translatedText).toBe("Hola");
    expect(next.activeTurn?.firstOutputTextAtMs).toBe(1500);
    expect(next.activeTurn?.outputTextEndAtMs).toBe(1500);
    expect(next.activeTurn?.status).toBe("outputting");
  });

  it("AUDIO_STARTED records the first audible output through the turn helper", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, { type: "AUDIO_STARTED", nowMs: 1600 });

    expect(next.activeTurn?.audioOutputStarted).toBe(true);
    expect(next.activeTurn?.firstAudibleOutputAtMs).toBe(1600);
    expect(next.expectedSpeaker).toBe("A");
  });

  it("PLAYBACK_ENDED records playbackEndAtMs without changing expectedSpeaker", () => {
    const state = stateWithCompletedTurn("A");
    const next = sessionReducer(state, { type: "PLAYBACK_ENDED", nowMs: 2100 });

    expect(next.activeTurn?.playbackEndAtMs).toBe(2100);
    expect(next.expectedSpeaker).toBe("A");
    expect(next.state).toBe("outputting");
  });

  it("fails fast when OUTPUT_DELTA arrives with no active turn", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: false });
    expect(() => sessionReducer(state, { type: "OUTPUT_DELTA", text: "Hola", nowMs: 1500 })).toThrow(
      /no active turn/i,
    );
  });
});

describe("sessionReducer: suspension flow (§11.3)", () => {
  it("discards an unfinished active turn and does not resume it", () => {
    const state = listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, { type: "SUSPEND" });

    expect(next.state).toBe("suspended");
    expect(next.activeTurn).toBeUndefined();
    expect(next.recentTurns[0]?.status).toBe("discarded");
  });

  it("keeps expectedSpeaker unchanged across suspend/resume so the same speaker can repeat", () => {
    const suspended = sessionReducer(
      listeningState({ expectedSpeaker: "A", sourceActive: true, speaker: "A" }),
      { type: "SUSPEND" },
    );
    const resumed = sessionReducer(suspended, { type: "RESUME" });

    expect(resumed.expectedSpeaker).toBe("A");
    expect(resumed.state).toBe("listening");
  });
});

describe("sessionReducer: lifecycle", () => {
  it("walks idle -> connecting -> context -> bootstrap -> listening (Flow A)", () => {
    let state = baseSession();
    state = sessionReducer(state, { type: "CONNECT" });
    expect(state.state).toBe("connecting");
    state = sessionReducer(state, { type: "CONTEXT_READY" });
    expect(state.state).toBe("context");
    state = sessionReducer(state, { type: "BOOTSTRAP_READY" });
    expect(state.state).toBe("bootstrap");
    state = sessionReducer(state, { type: "INTERPRETER_READY" });
    expect(state.state).toBe("listening");
  });

  it("walks idle -> connecting -> bootstrap -> listening (Flow B, context skipped)", () => {
    let state = baseSession();
    state = sessionReducer(state, { type: "CONNECT" });
    state = sessionReducer(state, { type: "SKIP_CONTEXT" });
    expect(state.state).toBe("bootstrap");
    state = sessionReducer(state, { type: "INTERPRETER_READY" });
    expect(state.state).toBe("listening");
  });

  it("fails fast on an invalid lifecycle transition", () => {
    const state = baseSession();
    expect(() => sessionReducer(state, { type: "BOOTSTRAP_READY" })).toThrow(/expected state "context"/i);
  });

  it("SESSION_ERROR is reachable from any non-ended state", () => {
    const next = sessionReducer(baseSession(), { type: "SESSION_ERROR", message: "boom" });
    expect(next.state).toBe("error");
  });

  it("END then ENDED terminates the session", () => {
    const listening = listeningState({ expectedSpeaker: "A", sourceActive: false });
    const ending = sessionReducer(listening, { type: "END" });
    expect(ending.state).toBe("ending");
    const ended = sessionReducer(ending, { type: "ENDED" });
    expect(ended.state).toBe("ended");
  });
});
