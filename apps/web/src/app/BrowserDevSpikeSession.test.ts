import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptDeltaEvent } from "../live/LiveEvents";
import { BrowserDevSpikeSession } from "./BrowserDevSpikeSession";

const liveClientMock = vi.hoisted(() => ({
  emitTranscriptDuringConnect: vi.fn(),
}));

vi.mock("../live/LiveClient", () => ({
  LiveClient: class {
    onTranscriptDelta: ((event: TranscriptDeltaEvent) => void) | null = null;
    onUsage: (() => void) | null = null;

    async connect(): Promise<{ sessionId: string }> {
      if (this.onTranscriptDelta === null) {
        throw new Error("Transcript callback was not set before connect");
      }
      liveClientMock.emitTranscriptDuringConnect(this.onTranscriptDelta);
      return { sessionId: "sess_adapter" };
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrowserDevSpikeSession", () => {
  it("wires transcript deltas before LiveClient connects", async () => {
    const transcriptEvent: TranscriptDeltaEvent = {
      type: "session.output_transcript.delta",
      delta: "visible caption",
    };
    const onTranscriptDelta = vi.fn();
    liveClientMock.emitTranscriptDuringConnect.mockImplementationOnce(
      (callback: (event: TranscriptDeltaEvent) => void) => {
        callback(transcriptEvent);
      },
    );
    const audioTrack = {
      getSettings: vi.fn(() => ({})),
      stop: vi.fn(),
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [audioTrack],
          getTracks: () => [audioTrack],
        })),
      },
    });

    await new BrowserDevSpikeSession().connect(vi.fn(), onTranscriptDelta);

    expect(onTranscriptDelta).toHaveBeenCalledWith(transcriptEvent);
  });
});
