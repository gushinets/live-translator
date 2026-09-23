import { describe, expect, it } from "vitest";
import { VoiceActivityMonitor } from "./VoiceActivityMonitor";

const SOURCE_TAIL_GRACE_MS = 1_000;

function pushQuietBaseline(monitor: VoiceActivityMonitor): void {
  for (let i = 0; i < 100; i += 1) {
    monitor.pushRms(0.01, false, i * 50);
  }
}

describe("VoiceActivityMonitor", () => {
  it("holds the source active through the server-ingestion tail after local VAD goes quiet", () => {
    const monitor = new VoiceActivityMonitor();
    const events: Array<{ active: boolean; atMs: number }> = [];
    monitor.onActivity = (event) => events.push(event);

    pushQuietBaseline(monitor);
    monitor.pushRms(0.08, false, 5_100);
    monitor.pushRms(0.09, false, 5_150);
    expect(events).toEqual([{ active: true, atMs: 5_150 }]);

    monitor.pushRms(0, false, 5_200);
    monitor.pushRms(0, false, 5_600);
    monitor.pushRms(0, false, 5_650);

    expect(events).toEqual([{ active: true, atMs: 5_150 }]);

    monitor.pushRms(0, false, 5_650 + SOURCE_TAIL_GRACE_MS - 50);
    expect(events).toEqual([{ active: true, atMs: 5_150 }]);

    monitor.pushRms(0, false, 5_650 + SOURCE_TAIL_GRACE_MS);
    expect(events).toEqual([
      { active: true, atMs: 5_150 },
      { active: false, atMs: 5_650 + SOURCE_TAIL_GRACE_MS },
    ]);
  });
});

it("exposes pre-tail samples while retaining the original delayed product edges", () => {
  const monitor = new VoiceActivityMonitor(), samples: Array<{active: boolean; atMs: number}> = [];
  monitor.onSample = sample => samples.push(sample);
  pushQuietBaseline(monitor); monitor.pushRms(.08, false, 5100); monitor.pushRms(.09, false, 5150);
  monitor.pushRms(0, false, 5200); monitor.pushRms(0, false, 5600); monitor.pushRms(0, false, 5650);
  expect(samples.at(-1)).toEqual({ active: false, atMs: 5650 }); expect(monitor.active).toBe(true);
});
