import { beforeAll, describe, expect, it } from "vitest";
import { FlyRegistry } from "../game/FlyRegistry";
import { N_ACTIONS } from "../game/Motor";
import { FlyDecisionTelemetry, FlyTelemetry } from "../game/Telemetry";
import { playHeadless } from "../train/HeadlessGame";
import { loadConnectomeFromDisk } from "../train/NodeBrainLoader";

beforeAll(() => {
  FlyRegistry.setConnectome(loadConnectomeFromDisk());
  console.log = () => {};
});

describe("a fly in a real game", () => {
  it("lands, senses, thinks and acts", async () => {
    const seen: FlyTelemetry[] = [];
    FlyRegistry.setTelemetrySink((t) => seen.push(t));
    const res = await playHeadless({
      map: "pangaea",
      compact: true,
      bots: 20,
      seed: "fly-test",
      maxTicks: 900,
      fly: { policy: "teacher", telemetry: true },
    });
    FlyRegistry.setTelemetrySink(null);

    expect(res.alive).toBe(true);
    expect(res.decisions).toBeGreaterThan(20);
    expect(res.landShare).toBeGreaterThan(0);
    expect(
      seen.some((t) => t.type === "openfly_status" && t.status === "spawned"),
    ).toBe(true);

    const decisions = seen.filter(
      (t): t is FlyDecisionTelemetry => t.type === "openfly_decision",
    );
    expect(decisions.length).toBe(res.decisions);
    const last = decisions[decisions.length - 1];
    expect(last.senses).toHaveLength(13);
    expect(last.mask).toHaveLength(N_ACTIONS);
    expect(last.mask[0]).toBe(1);
    // The brain was actually running: spikes were recorded in the window.
    expect(decisions.some((d) => d.totalSpikes > 0)).toBe(true);
    for (const d of decisions) {
      for (const v of d.senses) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(d.mask[d.action]).toBe(1);
    }
  });
});
