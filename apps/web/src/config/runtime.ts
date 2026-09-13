/**
 * Runtime timing constants for the MVP prototype. Binding spec 1.2.1 §4.5,
 * §5.5, and §10.2. These are tuning configuration, not business invariants;
 * device/audio testing is expected to inform future adjustments.
 */
export const runtime = {
  /** Application-level timeout waiting for ICE gathering to complete. */
  iceGatherTimeoutMs: 10_000,
  /** §5.5: initial prototype default for per-turn/startup steering acknowledgment. */
  steeringAckTimeoutMs: 3_000,
  /** §4.5: closes an abandoned CONTEXT-phase session. */
  contextIdleTimeoutMs: 120_000,
  /** §4.5: closes an abandoned BOOTSTRAP-phase session. */
  bootstrapIdleTimeoutMs: 60_000,
  /** §4.5: application-wide maximum session duration (15 minutes). */
  maxSessionMs: 900_000,
  /** Maximum duration for a single uninterrupted source turn. */
  maxSourceMs: 30_000,
  /** §10.2: local remote-audio inactivity window used to derive `playbackIdle`. */
  playbackIdleMs: 500,
  /** §10.2: output-transcript inactivity window used to derive `captionIdle`. */
  captionIdleMs: 600,
  /** §10.1 branch B: grace period before falling back to text-only completion. */
  audioStartGraceMs: 1_000,
  /** §10.1 branch A: grace period to wait for output continuation after early playback idle. */
  postSourceOutputGraceMs: 700,
  /** §10.1: grace period with no fresh output text/audio before a turn may close. */
  outputSettleGraceMs: 350,
  /** §10.1 branch C: deadlock escape when neither usable text nor audio ever appears. */
  noOutputTimeoutMs: 5_000,
} as const;

export type RuntimeConfig = typeof runtime;
