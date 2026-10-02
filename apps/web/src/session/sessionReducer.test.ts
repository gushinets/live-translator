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
  initialSpeaker: Side;
  sourceActive: boolean;
  speaker?: Side;
}): TranslationSession {
  const speaker = options.speaker ?? options.initialSpeaker;
  const activeTurn: Turn | undefined = options.sourceActive
    ? createTurn({ id: "active-turn", speaker, sideSource: "language", nowMs: 1000 })
    : undefined;
  return {
    ...baseSession(),
    state: "listening",

    activeTurn,
  };
}

/** A session in `outputting` with an active turn from `speaker`, ready to close. */
function stateWithCompletedTurn(speaker: Side): TranslationSession {
  const activeTurn: Turn = {
    ...createTurn({ id: "active-turn", speaker, sideSource: "language", nowMs: 1000 }),
    status: "outputting",
    sourceIdleAtMs: 1200,
  };
  return {
    ...baseSession(),
    state: "outputting",
    activeTurn,
  };
}

const SOURCE_APPEND_BLOCKED_STATES = ["ending", "ended", "error", "suspended"] as const;
const TURN_CLOSE_BLOCKED_STATES = ["error", "ended", "suspended"] as const;
const OUTPUT_EVENT_BLOCKED_STATES = ["error", "ended", "suspended"] as const;

describe("sessionReducer: transcript routing", () => {
  function unresolved(originalText = ""): TranslationSession {
    return {
      ...baseSession(), state: "listening",
      participantA: { ...participant("A"), language: "ru" },
      participantB: { ...participant("B"), language: "en" },
      activeTurn: { ...createTurn({ id: "short", speaker: undefined, sideSource: "unresolved", nowMs: 1000 }), originalText },
    };
  }
  it.each(["", "OK", "12345"])("routes an unresolved source %j using the translation language", (originalText) => {
    const next = sessionReducer(unresolved(originalText), { type: "OUTPUT_DELTA", text: "Хорошо", nowMs: 1500 });
    expect(next.activeTurn?.speaker).toBe("B");
    expect(next.activeTurn?.translatedText).toBe("Хорошо");
  });
  it("routes a reliable English translation to B's pane", () => {
    expect(sessionReducer(unresolved("Да"), { type: "OUTPUT_DELTA", text: "Thank you", nowMs: 1500 }).activeTurn?.speaker).toBe("A");
  });
  it("keeps a resolved side when a later source delta is still ambiguous", () => {
    const output = sessionReducer(unresolved(), { type: "OUTPUT_DELTA", text: "Хорошо", nowMs: 1500 });
    const next = sessionReducer(output, { type: "SOURCE_FRAGMENT", fragment: { id: "late", text: "OK", receivedAtMs: 1600 } });
    expect(next.activeTurn?.speaker).toBe("B");
  });
  it("corrects a translation's language as streamed text grows", () => {
    const state = unresolved("OK");
    state.participantA.language = "en";
    state.participantB.language = "es";
    const prefix = sessionReducer(state, { type: "OUTPUT_DELTA", text: "Thank y", nowMs: 1500 });
    const complete = sessionReducer(prefix, { type: "OUTPUT_DELTA", text: "ou", nowMs: 1600 });
    expect(complete.activeTurn?.translatedText).toBe("Thank you");
    expect(complete.activeTurn?.speaker).toBe("B");
  });
  it("lets a late reliable source override translation-based routing", () => {
    const output = sessionReducer(unresolved(), { type: "OUTPUT_DELTA", text: "Хорошо", nowMs: 1500 });
    const next = sessionReducer(output, { type: "SOURCE_FRAGMENT", fragment: { id: "late", text: "Подскажите, пожалуйста, где находится вокзал?", receivedAtMs: 1600 } });
    expect(next.activeTurn?.speaker).toBe("A");
    expect(next.activeTurn?.sideSource).toBe("language");
  });
  it("keeps ambiguous text unassigned and trusts source language over output language", () => {
    expect(sessionReducer(unresolved("OK"), { type: "OUTPUT_DELTA", text: "OK", nowMs: 1500 }).activeTurn?.speaker).toBeUndefined();
    expect(sessionReducer(unresolved("Подскажите, пожалуйста, где находится вокзал?"), { type: "OUTPUT_DELTA", text: "Хорошо", nowMs: 1500 }).activeTurn?.speaker).toBe("A");
  });
});

function sessionWithActiveTurnIn(state: (typeof TURN_CLOSE_BLOCKED_STATES)[number]): TranslationSession {
  if (state === "error") {
    return sessionReducer(stateWithCompletedTurn("A"), { type: "SESSION_ERROR", message: "boom" });
  }
  return { ...stateWithCompletedTurn("A"), state };
}

describe("sessionReducer: OUTPUT_IDLE never changes initialSpeaker or state", () => {
  it("does not change expected speaker when output ends before source idle", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: true });
    const next = sessionReducer(state, { type: "OUTPUT_IDLE" });
    expect(next).not.toHaveProperty("expectedSpeaker");
    expect(next.state).toBe("listening");
  });

  it("does not change initialSpeaker when OUTPUT_IDLE arrives with no active turn", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: false });
    const next = sessionReducer(state, { type: "OUTPUT_IDLE" });
    expect(next).not.toHaveProperty("expectedSpeaker");
    expect(next.state).toBe("listening");
    expect(next).toBe(state);
  });
});

describe("sessionReducer: completed turns do not predict the next speaker", () => {
  it("does not assign an expected speaker after a completed source turn", () => {
    const next = sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_CLOSED", speaker: "A" });
    expect(next).not.toHaveProperty("expectedSpeaker");
  });

  it("moves the closed turn into recentTurns as completed and clears activeTurn", () => {
    const next = sessionReducer(stateWithCompletedTurn("B"), { type: "TURN_CLOSED", speaker: "B" });
    expect(next.activeTurn).toBeUndefined();
    expect(next.recentTurns).toHaveLength(1);
    expect(next.recentTurns[0]?.status).toBe("completed");
    expect(next.lastSpeaker).toBe("B");
  });

  it("marks the completed speaker as having accepted conversation speech", () => {
    const next = sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_CLOSED", speaker: "A" });
    expect(next.participantA.hasAcceptedConversationSpeech).toBe(true);
    expect(next.participantB.hasAcceptedConversationSpeech).toBe(false);
  });

  it("does not mark failed speech as accepted", () => {
    const next = sessionReducer(stateWithCompletedTurn("A"), { type: "TURN_FAILED" });
    expect(next.participantA.hasAcceptedConversationSpeech).toBe(false);
    expect(next).not.toHaveProperty("expectedSpeaker");
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
    const state = listeningState({ initialSpeaker: "A", sourceActive: false });
    expect(() => sessionReducer(state, { type: "TURN_CLOSED", speaker: "A" })).toThrow(/no active turn/i);
  });

  it.each(TURN_CLOSE_BLOCKED_STATES)("rejects TURN_CLOSED while session state is %s", (blockedState) => {
    const state = sessionWithActiveTurnIn(blockedState);
    expect(() => sessionReducer(state, { type: "TURN_CLOSED", speaker: "A" })).toThrow(new RegExp(blockedState));
  });

  it.each(TURN_CLOSE_BLOCKED_STATES)("rejects TURN_FAILED while session state is %s", (blockedState) => {
    const state = sessionWithActiveTurnIn(blockedState);
    expect(() => sessionReducer(state, { type: "TURN_FAILED" })).toThrow(new RegExp(blockedState));
  });

  it("completes a draining turn while ending without returning to listening", () => {
    const ending = sessionReducer(stateWithCompletedTurn("A"), { type: "END" });
    const next = sessionReducer(ending, { type: "TURN_CLOSED", speaker: "A" });

    expect(next.state).toBe("ending");
    expect(next.activeTurn).toBeUndefined();
    expect(next.recentTurns[0]?.status).toBe("completed");
  });

  it("fails a draining turn while ending without returning to listening", () => {
    const ending = sessionReducer(stateWithCompletedTurn("A"), { type: "END" });
    const next = sessionReducer(ending, { type: "TURN_FAILED" });

    expect(next.state).toBe("ending");
    expect(next.activeTurn).toBeUndefined();
    expect(next.recentTurns[0]?.status).toBe("failed");
  });
});

describe("sessionReducer: main conversation flow", () => {
  it("SOURCE_ACTIVE starts a fresh turn while listening with no active turn", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: false });
    const next = sessionReducer(state, {
      type: "SOURCE_ACTIVE",
      turnId: "t1",
      speaker: "A",
      sideSource: "language",
    });
    expect(next.activeTurn?.id).toBe("t1");
    expect(next.activeTurn?.status).toBe("streaming");
    expect(next.state).toBe("listening");
  });

  it("SOURCE_ACTIVE for the same speaker continues the existing active turn", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, {
      type: "SOURCE_ACTIVE",
      turnId: "active-turn",
      speaker: "A",
      sideSource: "language",
      fragment: { id: "f1", text: "hola", receivedAtMs: 1050 },
    });
    expect(next.activeTurn?.originalText).toBe("hola");
  });

  it("clears sourceIdleAtMs when the same speaker continues after a premature idle", () => {
    const idle = sessionReducer(
      listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" }),
      { type: "SOURCE_IDLE" },
    );
    expect(idle.activeTurn?.sourceIdleAtMs).toBeDefined();

    const next = sessionReducer(idle, {
      type: "SOURCE_ACTIVE",
      turnId: "active-turn",
      speaker: "A",
      sideSource: "language",
    });
    expect(next.activeTurn?.sourceIdleAtMs).toBeUndefined();
    expect(next.activeTurn?.id).toBe("active-turn");
  });

  it("does not throw or change initialSpeaker when SOURCE_IDLE arrives with no active turn", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: false });
    const next = sessionReducer(state, { type: "SOURCE_IDLE" });
    expect(next).not.toHaveProperty("expectedSpeaker");
    expect(next.state).toBe("listening");
    expect(next).toBe(state);
  });

  it.each(SOURCE_APPEND_BLOCKED_STATES)("rejects SOURCE_ACTIVE while session state is %s", (blockedState) => {
    const state: TranslationSession = {
      ...listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" }),
      state: blockedState,
    };
    expect(() =>
      sessionReducer(state, {
        type: "SOURCE_ACTIVE",
        turnId: "active-turn",
        speaker: "A",
        sideSource: "language",
      }),
    ).toThrow(new RegExp(blockedState));
  });

  it.each(SOURCE_APPEND_BLOCKED_STATES)("rejects SOURCE_FRAGMENT while session state is %s", (blockedState) => {
    const state: TranslationSession = {
      ...listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" }),
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
    const state = listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" });
    expect(() =>
      sessionReducer(state, { type: "SOURCE_ACTIVE", turnId: "t2", speaker: "B", sideSource: "language" }),
    ).toThrow(/has not been closed/i);
  });

  it("OUTPUT_ACTIVE moves listening to outputting and marks the turn outputting", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, { type: "OUTPUT_ACTIVE" });
    expect(next.state).toBe("outputting");
    expect(next.activeTurn?.status).toBe("outputting");
  });

  it("SOURCE_IDLE records sourceIdleAtMs without changing state or initialSpeaker", () => {
    const state = stateWithCompletedTurn("A");
    const next = sessionReducer(state, { type: "SOURCE_IDLE" });
    expect(next.activeTurn?.sourceIdleAtMs).toBeDefined();
    expect(next.state).toBe("outputting");
    expect(next).not.toHaveProperty("expectedSpeaker");
  });

  it("TURN_FAILED keeps initialSpeaker on the same source side (§10.3)", () => {
    const state = stateWithCompletedTurn("A");
    const next = sessionReducer(state, { type: "TURN_FAILED" });
    expect(next).not.toHaveProperty("expectedSpeaker");
    expect(next.state).toBe("listening");
    expect(next.recentTurns[0]?.status).toBe("failed");
    expect(next.activeTurn).toBeUndefined();
  });
});

describe("sessionReducer: output epoch actions", () => {
  it("OUTPUT_DELTA appends text through the turn helper and moves listening to outputting", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, { type: "OUTPUT_DELTA", text: "Hola", nowMs: 1500 });

    expect(next.state).toBe("outputting");
    expect(next.activeTurn?.translatedText).toBe("Hola");
    expect(next.activeTurn?.firstOutputTextAtMs).toBe(1500);
    expect(next.activeTurn?.outputTextEndAtMs).toBe(1500);
    expect(next.activeTurn?.status).toBe("outputting");
  });

  it("AUDIO_STARTED records the first audible output through the turn helper", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, { type: "AUDIO_STARTED", nowMs: 1600 });

    expect(next.activeTurn?.audioOutputStarted).toBe(true);
    expect(next.activeTurn?.firstAudibleOutputAtMs).toBe(1600);
    expect(next).not.toHaveProperty("expectedSpeaker");
  });

  it("PLAYBACK_ENDED records playbackEndAtMs without changing initialSpeaker", () => {
    const state = stateWithCompletedTurn("A");
    const next = sessionReducer(state, { type: "PLAYBACK_ENDED", nowMs: 2100 });

    expect(next.activeTurn?.playbackEndAtMs).toBe(2100);
    expect(next).not.toHaveProperty("expectedSpeaker");
    expect(next.state).toBe("outputting");
  });

  it("fails fast when OUTPUT_DELTA arrives with no active turn", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: false });
    expect(() => sessionReducer(state, { type: "OUTPUT_DELTA", text: "Hola", nowMs: 1500 })).toThrow(
      /no active turn/i,
    );
  });

  it.each(OUTPUT_EVENT_BLOCKED_STATES)("rejects OUTPUT_DELTA while session state is %s", (blockedState) => {
    const state = sessionWithActiveTurnIn(blockedState);
    expect(() => sessionReducer(state, { type: "OUTPUT_DELTA", text: "stale", nowMs: 1500 })).toThrow(
      new RegExp(blockedState),
    );
  });

  it.each(OUTPUT_EVENT_BLOCKED_STATES)("rejects AUDIO_STARTED while session state is %s", (blockedState) => {
    const state = sessionWithActiveTurnIn(blockedState);
    expect(() => sessionReducer(state, { type: "AUDIO_STARTED", nowMs: 1600 })).toThrow(new RegExp(blockedState));
  });

  it.each(OUTPUT_EVENT_BLOCKED_STATES)("rejects PLAYBACK_ENDED while session state is %s", (blockedState) => {
    const state = sessionWithActiveTurnIn(blockedState);
    expect(() => sessionReducer(state, { type: "PLAYBACK_ENDED", nowMs: 2100 })).toThrow(new RegExp(blockedState));
  });

  it.each(OUTPUT_EVENT_BLOCKED_STATES)("rejects OUTPUT_ACTIVE while session state is %s", (blockedState) => {
    const state = sessionWithActiveTurnIn(blockedState);
    expect(() => sessionReducer(state, { type: "OUTPUT_ACTIVE" })).toThrow(new RegExp(blockedState));
  });

  it("accepts OUTPUT_DELTA while ending so a turn can drain", () => {
    const ending = sessionReducer(stateWithCompletedTurn("A"), { type: "END" });
    const next = sessionReducer(ending, { type: "OUTPUT_DELTA", text: "tail", nowMs: 4000 });
    expect(next.state).toBe("ending");
    expect(next.activeTurn?.translatedText).toBe("tail");
  });
});

describe("sessionReducer: suspension flow (§11.3)", () => {
  it("discards an unfinished active turn and does not resume it", () => {
    const state = listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" });
    const next = sessionReducer(state, { type: "SUSPEND" });

    expect(next.state).toBe("suspended");
    expect(next.activeTurn).toBeUndefined();
    expect(next.recentTurns[0]?.status).toBe("discarded");
  });

  it("keeps initialSpeaker unchanged across suspend/resume so the same speaker can repeat", () => {
    const suspended = sessionReducer(
      listeningState({ initialSpeaker: "A", sourceActive: true, speaker: "A" }),
      { type: "SUSPEND" },
    );
    const resumed = sessionReducer(suspended, { type: "RESUME" });

    expect(resumed).not.toHaveProperty("expectedSpeaker");
    expect(resumed.state).toBe("listening");
  });

  it("rejects SUSPEND from error", () => {
    const errored = sessionReducer(
      listeningState({ initialSpeaker: "A", sourceActive: false }),
      { type: "SESSION_ERROR", message: "boom" },
    );
    expect(() => sessionReducer(errored, { type: "SUSPEND" })).toThrow(/error/);
  });

  it("rejects SUSPEND from ending", () => {
    const ending = sessionReducer(listeningState({ initialSpeaker: "A", sourceActive: false }), { type: "END" });
    expect(() => sessionReducer(ending, { type: "SUSPEND" })).toThrow(/ending/);
  });

  it("does not resume an error session into listening", () => {
    const errored = sessionReducer(
      listeningState({ initialSpeaker: "A", sourceActive: false }),
      { type: "SESSION_ERROR", message: "boom" },
    );
    expect(() => sessionReducer(errored, { type: "RESUME" })).toThrow();
  });

  it("does not resume an ending session into listening", () => {
    const ending = sessionReducer(listeningState({ initialSpeaker: "A", sourceActive: false }), { type: "END" });
    expect(() => sessionReducer(ending, { type: "RESUME" })).toThrow();
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
    const listening = listeningState({ initialSpeaker: "A", sourceActive: false });
    const ending = sessionReducer(listening, { type: "END" });
    expect(ending.state).toBe("ending");
    const ended = sessionReducer(ending, { type: "ENDED" });
    expect(ended.state).toBe("ended");
  });
});
