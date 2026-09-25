import { beforeAll, describe, expect, it } from "vitest";
import { Connectome } from "../brain/Connectome";
import { LIFBrain, SHIU_PARAMS } from "../brain/LIFBrain";
import { loadConnectomeFromDisk } from "../train/NodeBrainLoader";

// The simulator skips neurons that cannot fire and catches them up later in
// one exact jump. This checks it against the plainest possible version:
// every neuron, every step, same Poisson draws.

function naiveCounts(c: Connectome, seed: number, rates: number[], steps: number) {
  const p = SHIU_PARAMS;
  const n = c.nSim;
  const u = new Float64Array(n);
  const g = new Float64Array(n);
  const refr = new Uint8Array(n);
  const counts = new Uint32Array(n);
  const res = new Float64Array(n).fill(1);
  const lastSpike = new Int32Array(n).fill(-1_000_000);
  const stdU = new Float64Array(n).fill(p.stdU);
  for (const list of c.channelNeurons) for (const i of list) stdU[i] = 0;
  const em = Math.exp(-p.dtMs / p.tauMemMs);
  const es = Math.exp(-p.dtMs / p.tauSynMs);
  const kg = (p.tauSynMs / (p.tauMemMs - p.tauSynMs)) * (em - es);
  const delay = Math.round(p.delayMs / p.dtMs);
  const refrSteps = Math.round(p.refractoryMs / p.dtMs);
  const queue: { t: number; pre: number; eff: number }[] = [];
  let rng = seed >>> 0 || 0x9e3779b9;
  const rand = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    rng >>>= 0;
    return rng / 4294967296;
  };
  for (let t = 0; t < steps; t++) {
    for (const s of queue.filter((q) => q.t === t)) {
      for (let e = c.rowptr[s.pre]; e < c.rowptr[s.pre + 1]; e++) {
        g[c.col[e]] += c.weight[e] * p.wSynMv * s.eff;
      }
    }
    for (let ch = 0; ch < c.channelNeurons.length; ch++) {
      const prob = (rates[ch] * p.dtMs) / 1000;
      if (prob <= 0) continue;
      for (const i of c.channelNeurons[ch]) {
        if (rand() < prob && refr[i] === 0) u[i] = p.thresholdMv + 1;
      }
    }
    for (let i = 0; i < n; i++) {
      if (refr[i] > 0) {
        refr[i]--;
        continue;
      }
      if (u[i] <= p.thresholdMv) {
        u[i] = u[i] * em + g[i] * kg;
        g[i] *= es;
      }
      if (u[i] > p.thresholdMv) {
        u[i] = 0;
        g[i] = 0;
        refr[i] = refrSteps;
        const elapsed = ((t - lastSpike[i]) * p.dtMs) / p.stdTauRecMs;
        const x = elapsed > 20 ? 1 : 1 - (1 - res[i]) * Math.exp(-elapsed);
        res[i] = x * (1 - stdU[i]);
        lastSpike[i] = t;
        // Emitted at the end of step t, felt from the start of step t+delay+1.
        queue.push({ t: t + delay + 1, pre: i, eff: x });
        counts[i]++;
      }
    }
  }
  return counts;
}

let c: Connectome;
beforeAll(() => {
  c = loadConnectomeFromDisk();
});

describe("lazy LIF integration", () => {
  it("fires exactly the spikes of a naive every-neuron integrator", () => {
    const rates = c.meta.channels.map((_, i) => (i % 3 === 0 ? 120 : i % 3 === 1 ? 40 : 0));
    const steps = 150;
    const brain = new LIFBrain(c, 99);
    rates.forEach((hz, ch) => brain.setChannelRate(ch, hz));
    brain.run(steps);
    const ref = naiveCounts(c, 99, rates, steps);
    let total = 0;
    let mismatched = 0;
    for (let i = 0; i < c.nSim; i++) {
      total += ref[i];
      if (ref[i] !== brain.counts[i]) mismatched++;
    }
    expect(total).toBeGreaterThan(1000);
    // Float32 state vs float64 here: allow a handful of borderline neurons.
    expect(mismatched).toBeLessThanOrEqual(Math.ceil(0.002 * c.nSim));
  });
});
