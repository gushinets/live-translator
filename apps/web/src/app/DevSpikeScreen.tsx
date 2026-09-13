import { useRef, useState } from "react";
import type { DeviceDiagnosticsSnapshot } from "../diagnostics/DeviceDiagnostics";
import type { LiveCloseResult } from "../live/LiveClient";
import type { TranscriptDeltaEvent } from "../live/LiveEvents";
import { createBrowserDevSpikeSession } from "./BrowserDevSpikeSession";

export interface DevSpikeConnection {
  sessionId: string;
  microphoneSettings: MediaTrackSettings;
  diagnostics: DeviceDiagnosticsSnapshot;
}

export interface DevSpikeSession {
  connect(
    onRemoteStream: (stream: MediaStream) => void,
    onTranscriptDelta: (event: TranscriptDeltaEvent) => void,
  ): Promise<DevSpikeConnection>;
  close(): Promise<LiveCloseResult>;
}

export interface DevSpikeScreenProps {
  createSession?: () => DevSpikeSession;
}

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "ending"
  | "ended"
  | "error";

export function DevSpikeScreen({
  createSession = createBrowserDevSpikeSession,
}: DevSpikeScreenProps) {
  const [session] = useState(() => createSession());
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [connection, setConnection] = useState<DevSpikeConnection | null>(null);
  const [hasReceivedSessionClosed, setHasReceivedSessionClosed] = useState<
    boolean | null
  >(null);
  const [transcriptDeltas, setTranscriptDeltas] = useState<
    TranscriptDeltaEvent[]
  >([]);
  const audioRef = useRef<HTMLAudioElement>(null);

  function handleRemoteStream(stream: MediaStream): void {
    if (audioRef.current === null) {
      throw new Error("Remote audio element is unavailable");
    }
    audioRef.current.srcObject = stream;
  }

  function handleTranscriptDelta(event: TranscriptDeltaEvent): void {
    setTranscriptDeltas((currentDeltas) => [...currentDeltas, event]);
  }

  async function connect(): Promise<void> {
    setConnectionStatus("connecting");
    try {
      const nextConnection = await session.connect(
        handleRemoteStream,
        handleTranscriptDelta,
      );
      setConnection(nextConnection);
      setConnectionStatus("connected");
    } catch (error) {
      setConnectionStatus("error");
      console.error("DEV spike screen connection failed", { error });
      throw error;
    }
  }

  async function end(): Promise<void> {
    setConnectionStatus("ending");
    try {
      const result = await session.close();
      setHasReceivedSessionClosed(result.finalized);
      setConnectionStatus("ended");
    } catch (error) {
      setConnectionStatus("error");
      console.error("DEV spike screen close failed", { error });
      throw error;
    }
  }

  return (
    <section aria-label="Live transport device spike">
      <button
        type="button"
        disabled={connectionStatus !== "idle"}
        onClick={() => void connect()}
      >
        Connect
      </button>
      <p>Connection: {connectionStatus}</p>
      <p>Session: {connection?.sessionId ?? "none"}</p>
      <button
        type="button"
        disabled={connectionStatus !== "connected"}
        onClick={() => void end()}
      >
        End
      </button>
      <audio ref={audioRef} data-testid="remote-audio" autoPlay controls />
      {connection === null ? (
        <p>Microphone settings: not captured</p>
      ) : (
        <>
          <p>Microphone settings:</p>
          <pre>{JSON.stringify(connection.microphoneSettings, null, 2)}</pre>
          <p>Transport diagnostics:</p>
          <pre>{JSON.stringify(connection.diagnostics, null, 2)}</pre>
        </>
      )}
      {transcriptDeltas.length === 0 ? (
        <p>Transcript/caption deltas: none</p>
      ) : (
        <>
          <p>Transcript/caption deltas:</p>
          <pre>{JSON.stringify(transcriptDeltas, null, 2)}</pre>
        </>
      )}
      {hasReceivedSessionClosed === null ? null : (
        <p>
          session.closed:{" "}
          {hasReceivedSessionClosed ? "received" : "not received"}
        </p>
      )}
    </section>
  );
}
