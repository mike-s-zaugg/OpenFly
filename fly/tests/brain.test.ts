import { beforeAll, describe, expect, it } from "vitest";
import { Connectome } from "../brain/Connectome";
import { LIFBrain } from "../brain/LIFBrain";
import { maskedArgmax, maskedSoftmax, Readout } from "../brain/Readout";
import { SENSE_KEYS } from "../game/Senses";
import { loadConnectomeFromDisk } from "../train/NodeBrainLoader";

let c: Connectome;

beforeAll(() => {
  c = loadConnectomeFromDisk();
});

describe("connectome", () => {
  it("holds the FlyWire 783 brain with a simulated central part", () => {
    expect(c.nAll).toBe(139248);
    expect(c.nSim).toBeLessThan(65536);
    expect(c.rowptr.length).toBe(c.nSim + 1);
    expect(c.rowptr[c.nSim]).toBe(c.col.length);
    expect(c.pos.length).toBe(c.nAll * 3);
    // Every edge targets a simulated neuron.
    let max = 0;
    for (let e = 0; e < c.col.length; e += 997) max = Math.max(max, c.col[e]);
    expect(max).toBeLessThan(c.nSim);
  });

  it("has one sensory channel per sense, in the same order", () => {
    expect(c.meta.channels.map((ch) => ch.key)).toEqual([...SENSE_KEYS]);
    for (const list of c.channelNeurons) {
      expect(list.length).toBeGreaterThan(20);
      for (const i of list) expect(i).toBeLessThan(c.nSim);
    }
  });

  it("reads out from descending and motor neurons", () => {
    expect(c.readout.length).toBeGreaterThan(1300);
    for (const i of c.readout) {
      expect(["descending", "motor"]).toContain(c.superClassName(i));
    }
    // MN9, the proboscis motor neuron driven by sugar in Shiu et al.
    expect(c.meta.landmarks["CB0701"].length).toBeGreaterThan(0);
  });
});

describe("LIF brain", () => {
  it("is silent without sensory input", () => {
    const b = new LIFBrain(c, 1);
    b.runMs(50);
    expect(b.totalSpikes).toBe(0);
  });

  it("carries sugar taste to the readout neurons", () => {
    const b = new LIFBrain(c, 2);
    b.setChannelRate(c.channelIndex("sugar"), 150);
    b.runMs(200);
    let readoutSpikes = 0;
    for (const i of c.readout) readoutSpikes += b.counts[i];
    expect(readoutSpikes).toBeGreaterThan(0);
  });

  it("falls quiet again once the senses go quiet (no runaway loops)", () => {
    const b = new LIFBrain(c, 3);
    for (let ch = 0; ch < c.channelNeurons.length; ch++)
      b.setChannelRate(ch, 120);
    b.runMs(400);
    for (let ch = 0; ch < c.channelNeurons.length; ch++)
      b.setChannelRate(ch, 0);
    b.runMs(300);
    const before = b.totalSpikes;
    b.runMs(100);
    expect(b.totalSpikes - before).toBe(0);
  });

  it("is deterministic for a seed", () => {
    const run = () => {
      const b = new LIFBrain(c, 42);
      b.setChannelRate(c.channelIndex("looming"), 100);
      b.setChannelRate(c.channelIndex("energy"), 60);
      b.runMs(100);
      return Array.from(c.readout, (i) => b.counts[i]);
    };
    expect(run()).toEqual(run());
  });
});

describe("readout", () => {
  it("never picks an infeasible motor program", () => {
    const scores = Float32Array.from([0, 5, 1, 9, 0, 0, 0, 0, 0, 0]);
    const mask = Uint8Array.from([1, 1, 1, 0, 1, 1, 1, 1, 1, 1]);
    expect(maskedArgmax(scores, mask)).toBe(1);
    const p = maskedSoftmax(scores, mask);
    expect(p[3]).toBe(0);
    expect(p.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 5);
  });

  it("scores spike counts linearly", () => {
    const r = new Readout({
      version: 1,
      brain: "test",
      windowMs: 100,
      actions: ["a", "b"],
      neurons: [0, 1],
      mean: [0, 0],
      std: [1, 1],
      W: [
        [1, 0],
        [0, 1],
      ],
      b: [0, 0.1],
    });
    const counts = new Uint16Array(4);
    counts[0] = 9;
    const s = r.scores(counts);
    expect(s[0]).toBeCloseTo(Math.log(10), 5);
    expect(s[1]).toBeCloseTo(0.1, 5);
  });
});
