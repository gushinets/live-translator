import { describe, expect, it } from "vitest";
import { ActiveTimeMetrics } from "./ActiveTimeMetrics";
const ready = { visible: true, state: "listening", interpreterReady: true, mediaReady: true };
describe("active-time-v1", () => {
  it("counts source listening and output, not inputReady, setup, correction or background", () => {
    const m = new ActiveTimeMetrics(0);
    m.update({ ...ready, interpreterReady: false, state: "bootstrap" }, 0);
    m.update(ready, 5000);
    m.update({ ...ready, state: "outputting" }, 15000);
    m.update({ ...ready, state: "correcting" }, 35000);
    m.update({ ...ready, visible: false, state: "suspended" }, 39000);
    expect(m.snapshot(45000)).toEqual({ observedWallMs: 45000, setupMs: 5000, activeInterpreterMs: 30000, visiblePausedMs: 4000 });
  });
  it("freezes durations at finalization and never counts media not ready", () => {
    const m = new ActiveTimeMetrics(0);
    m.update({ ...ready, mediaReady: false }, 0);
    m.update(ready, 2000); m.finish(5000);
    expect(m.snapshot(10000)).toMatchObject({ observedWallMs: 5000, activeInterpreterMs: 3000 });
  });
});
