/** Shared wire types only; runtime validation belongs to the API. No audio or arbitrary payloads. */
export type DiagnosticState = "idle" | "connecting" | "context" | "bootstrap" | "listening" | "outputting" | "suspended" | "error" | "ending" | "ended";
export type DiagnosticSide = "A" | "B";
export type DiagnosticCommand = "session.close" | "session.instructions.append" | "session.thinking.append" | "session.commentary.append" | "session.input_audio.mute" | "session.input_audio.unmute";
export type DiagnosticServerEvent = "session.started" | "session.input_transcript.delta" | "session.output_transcript.delta" | "session.instructions.appended" | "session.thinking.appended" | "session.commentary.appended" | "session.input_audio.muted" | "session.input_audio.unmuted" | "session.usage.updated" | "session.closed" | "error" | "unknown" | "invalid";
export interface DiagnosticData {
  "app.state": { action: string; from: DiagnosticState; to: DiagnosticState; generation: number; turnId?: string; speaker?: DiagnosticSide; fragmentId?: string; endMs?: number; inputReady: boolean; gateBMuted: boolean };
  "app.lifecycle": { phase: "hidden" | "visible" | "orientation" | "audio_interruption" | "audio_restored" | "reset" | "start" | "cancel" | "end" | "resume"; generation: number };
  "app.snapshot": { state: DiagnosticState; visible: boolean; inputReady: boolean; gateBMuted: boolean; trackLive: boolean | null; trackEnabled: boolean | null; contextState: string | null; muted: boolean; paused: boolean; pendingPlayback: boolean; playbackInputState: string; lastInputAt: number | null; lastOutputAt: number | null; lastPcmAt: number | null; lastPlaybackAt: number | null };
  "turn.wait": { turnId: string; decision: "continue" | "complete" | "fail-retry"; blockedBy?: "unattributed_playback" | "queued_audio"; retryAtMs?: number; sourceIdle: boolean; audioStarted: boolean; playbackIdle: boolean; captionIdle: boolean; hasOutputText: boolean; sourceIdleAtMs?: number; playbackIdleAtMs?: number; lastOutputActivityAtMs?: number };
  "turn.timer": { timer: "completion" | "caption" | "max_source" | "no_output"; phase: "armed" | "fired" | "cleared"; deadlineAtMs?: number; turnId?: string };
  "transcript.fragment": { kind: "input" | "output"; fragmentId: string; charCount: number; startMs?: number; endMs?: number };
  "transcript.route": { kind: "input" | "output"; fragmentIds: string[]; side?: DiagnosticSide; language?: string; pending: boolean };
  "attribution.decision": { generation: string; kind: "text" | "pcm" | "decision" | "revoked" | "deadline"; atMs: number; outputId?: string; sourceId?: string; revision?: number; candidateIds?: string[]; candidatesTruncated?: boolean; compatibleOutput?: boolean; firstReceivedAtMs?: number; matchedAtMs?: number; deadlineAtMs?: number; played?: boolean; basis?: "isolated_episode" | "uncertain" };
  "caption.block": { revision: number; blockId: string; kind: "input" | "output"; side?: DiagnosticSide; language?: string; outputId?: string; attribution?: "matched" | "unattributed"; charCount: number; removed: boolean };
  "caption.render": { revision: number; blockCount: number };
  "audio.state": { phase: "capture_requested" | "capture_ready" | "capture_failed" | "capture_stopped" | "capture_ended" | "track_muted" | "track_unmuted" | "capture_gate" | "playback_input" | "output_gate" | "context" | "baseline_reset" | "pcm_pending" | "playback_request" | "playback_permission" | "playback_activity" | "playback_reset" | "buffer_error" | "decoder_error" | "play_requested" | "play_started" | "play_failed"; enabled?: boolean; active?: boolean; turnId?: string; requestId?: number; generation?: number; contextState?: string; reason?: "controller" | "playback" | "echo_tail" | "speech" | "not_running"; echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean; channelCount?: number; sampleRate?: number; code?: number };
  "audio.vad": { stage: "raw" | "reported"; active: boolean; atMs: number; rms: number; noiseFloor: number | null; enterThreshold: number; quietThreshold: number; quietStartedAtMs: number | null; tailStartedAtMs: number | null };
  "audio.level": { fromMs: number; toMs: number; samples: number; minRms: number; maxRms: number; meanRms: number; blocked: boolean };
  "transport.state": { kind: "peer" | "ice" | "gathering" | "channel"; state: string };
  "transport.command": { type: DiagnosticCommand; phase: "sent" | "send_failed" | "ack" | "timeout" | "rejected"; commandId?: string; promptId?: string };
  "transport.event": { type: DiagnosticServerEvent; phase: "received" | "dropped"; reason?: "stale_generation" | "closing" | "awaiting_handoff" | "inactive" | "leftover_output" | "empty" | "setup_content"; fragmentId?: string; commandId?: string; charCount?: number };
  "transport.stats": { available: boolean; packetsSent: number | null; packetsReceived: number | null; packetsLost: number | null; bytesSent: number | null; bytesReceived: number | null; totalSamplesReceived: number | null; jitterBufferEmittedCount: number | null };
  "diagnostic.loss": { reason: "storage_unavailable" | "queue_overflow" | "expired" | "identity_lost" | "oversize" | "server_limit" | "invalid_event"; count: number; affectedStreamId?: string };
  "diagnostic.clock": { offsetMs: number; uncertaintyMs: number };
  "server.conversation": { status: "active" | "paused" | "resuming" | "ended"; version: number; reason?: string };
  "server.attempt": { state: "creating" | "active" | "closing" | "closed" | "failed" | "unknown"; generation: number; phase: "registered" | "updated"; cleanupReason?: string; cleanupResult?: string; resumeOutcome?: string; providerSessionId?: string; reason?: string };
}
export type DiagnosticType = keyof DiagnosticData;
export type DiagnosticEvent<K extends DiagnosticType = DiagnosticType> = K extends DiagnosticType ? {
  schemaVersion: 1; source: "browser" | "server"; conversationId: string; liveSessionId?: string;
  streamId: string; seq: number; wallMs: number; monoMs: number; type: K; data: DiagnosticData[K];
  text?: string; textTruncated?: boolean; clientBuildId?: string;
} : never;
export interface DiagnosticSink {
  emit<K extends DiagnosticType>(type: K, data: DiagnosticData[K], text?: string): void;
}
export interface DiagnosticPolicy { enabled: boolean; textEnabled: boolean; schemaVersion: 1 }
export interface DiagnosticReceipt { schemaVersion: 1; accepted: Array<{ streamId: string; seq: number }>; serverTime: number }
