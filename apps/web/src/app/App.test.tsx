import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptDeltaEvent } from "../live/LiveEvents";
import { App } from "./App";
import type { DevSpikeConnection } from "./DevSpikeScreen";

afterEach(cleanup);

describe("App", () => {
  it("renders the translator title", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Переводчик" }),
    ).toBeInTheDocument();
  });

  it("declares viewport-fit=cover for safe-area insets", () => {
    const indexHtml = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../index.html"),
      "utf8",
    );
    expect(indexHtml).toMatch(/viewport-fit=cover/);
  });

  it("exposes the transport spike controls in development", async () => {
    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Connect" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End" })).toBeInTheDocument();
    expect(screen.getByText("Connection: idle")).toBeInTheDocument();
    expect(screen.getByText("Session: none")).toBeInTheDocument();
    expect(screen.getByTestId("remote-audio")).toBeInTheDocument();
    expect(screen.getByText("Microphone settings: not captured")).toBeInTheDocument();
    expect(screen.getByText("Transcript/caption deltas: none")).toBeInTheDocument();
  });

  it("shows the context screen in production and keeps the DEV spike hidden", async () => {
    render(<App isDevelopment={false} />);

    expect(
      screen.getByRole("heading", { name: "Переводчик" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Начать перевод" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Речь обрабатывает OpenAI/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Live transport device spike"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("connects, reports diagnostics, renders remote audio, and closes gracefully", async () => {
    const remoteStream = {} as MediaStream;
    const connect = vi.fn(
      async (
        onRemoteStream: (stream: MediaStream) => void,
        onTranscriptDelta: (event: TranscriptDeltaEvent) => void,
      ): Promise<DevSpikeConnection> => {
        onRemoteStream(remoteStream);
        onTranscriptDelta({
          type: "session.input_transcript.delta",
          delta: "hello",
        });
        onTranscriptDelta({
          type: "session.output_transcript.delta",
          delta: "hola",
        });
        return {
          sessionId: "sess_device",
          microphoneSettings: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 48_000,
          },
          diagnostics: {
            connectionState: "connected",
            iceGatheringState: "complete",
            dataChannelState: "open",
            sessionId: "sess_device",
            usageSeconds: null,
          },
        };
      },
    );
    const close = vi.fn(async () => ({ finalized: true }));

    render(
      <App
        isDevelopment
        createSpikeSession={() => ({ connect, close })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(screen.getByText("Connection: connected")).toBeInTheDocument();
    });
    expect(screen.getByText("Session: sess_device")).toBeInTheDocument();
    expect(screen.getByText(/"echoCancellation": true/)).toBeInTheDocument();
    expect(screen.getByText(/"dataChannelState": "open"/)).toBeInTheDocument();
    expect(
      screen.getByText(/"type": "session.input_transcript.delta"/),
    ).toBeInTheDocument();
    expect(screen.getByText(/"delta": "hello"/)).toBeInTheDocument();
    expect(
      screen.getByText(/"type": "session.output_transcript.delta"/),
    ).toBeInTheDocument();
    expect(screen.getByText(/"delta": "hola"/)).toBeInTheDocument();
    expect(screen.getByTestId("remote-audio")).toHaveProperty(
      "srcObject",
      remoteStream,
    );

    fireEvent.click(screen.getByRole("button", { name: "End" }));

    await waitFor(() => {
      expect(screen.getByText("Connection: ended")).toBeInTheDocument();
    });
    expect(screen.getByText("session.closed: received")).toBeInTheDocument();
    expect(close).toHaveBeenCalledOnce();
  });
});
