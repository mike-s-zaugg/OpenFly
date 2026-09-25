// Calibration sweep for the LIF game brain: does activity die out after the
// senses go quiet, and how much of it reaches the descending neurons?
//   npx tsx ../fly/train/calibrateBrain.ts <gain> <stdU> <tauRecMs>
import { LIFBrain } from "../brain/LIFBrain";
import { loadConnectomeFromDisk } from "./NodeBrainLoader";

const gain = Number(process.argv[2] ?? "1");
const stdU = Number(process.argv[3] ?? "0.2");
const tau = Number(process.argv[4] ?? "250");
const c = loadConnectomeFromDisk();
const brain = new LIFBrain(c, 99, { stdU, stdTauRecMs: tau }, gain);
const nCh = c.channelNeurons.length;

// 1. Everything on for a second, then silence.
for (let ch = 0; ch < nCh; ch++) brain.setChannelRate(ch, 100);
let t0 = performance.now();
brain.runMs(1000);
const onMs = performance.now() - t0;
const spikesOn = brain.totalSpikes;
for (let ch = 0; ch < nCh; ch++) brain.setChannelRate(ch, 0);
brain.runMs(300);
const before = brain.totalSpikes;
brain.runMs(100);
const residual = brain.totalSpikes - before;
console.log(
  `gain ${gain} U ${stdU} tau ${tau}: all-on ${(spikesOn / c.nSim).toFixed(1)} Hz mean, ${onMs.toFixed(0)} ms/s of brain; residual 300-400 ms after off: ${residual} spikes`,
);

// 2. Per-channel reach into the readout, from a quiet brain.
const rows: string[] = [];
const profiles: Float32Array[] = [];
for (let ch = 0; ch < nCh; ch++) {
  brain.reset();
  brain.setChannelRate(ch, 120);
  brain.runMs(100);
  brain.resetCounts();
  brain.runMs(100);
  brain.setChannelRate(ch, 0);
  const prof = Float32Array.from(c.readout, (i) => brain.counts[i]);
  profiles.push(prof);
  const act = prof.filter((x) => x > 0).length;
  rows.push(`${c.meta.channels[ch].key}:${act}`);
}
console.log("readout neurons reached:", rows.join(" "));
// Distinctness: mean cosine similarity between channel readout profiles.
let sim = 0;
let n = 0;
for (let a = 0; a < nCh; a++)
  for (let b = a + 1; b < nCh; b++) {
    let d = 0,
      na = 0,
      nb = 0;
    for (let k = 0; k < profiles[a].length; k++) {
      d += profiles[a][k] * profiles[b][k];
      na += profiles[a][k] ** 2;
      nb += profiles[b][k] ** 2;
    }
    if (na > 0 && nb > 0) {
      sim += d / Math.sqrt(na * nb);
      n++;
    }
  }
console.log(`mean pairwise cosine of channel readout profiles: ${(sim / n).toFixed(3)}`);
