// Probe how sensory channels propagate to descending neurons, and time it.
//   npx tsx ../fly/train/probeBrain.ts [gain]
import { LIFBrain } from "../brain/LIFBrain";
import { loadConnectomeFromDisk } from "./NodeBrainLoader";

const gain = Number(process.argv[2] ?? "1");
const windowMs = Number(process.argv[3] ?? "100");
const c = loadConnectomeFromDisk();
console.log(
  `brain: ${c.nSim} simulated neurons, ${c.meta.nEdges} edges, readout ${c.readout.length}, gain ${gain}`,
);

function readoutCounts(brain: LIFBrain): number[] {
  return Array.from(c.readout, (i) => brain.counts[i]);
}

const brain = new LIFBrain(c, 1234, {}, gain);
for (let ch = 0; ch < c.channelNeurons.length; ch++) {
  brain.reset();
  brain.setChannelRate(ch, 150);
  const t0 = performance.now();
  brain.runMs(windowMs);
  const dt = performance.now() - t0;
  const ro = readoutCounts(brain);
  const active = ro.filter((x) => x > 0).length;
  const total = ro.reduce((a, b) => a + b, 0);
  let anyActive = 0;
  for (let i = 0; i < c.nSim; i++) if (brain.counts[i] > 0) anyActive++;
  console.log(
    `${c.meta.channels[ch].key.padEnd(11)} DN/MN active ${String(active).padStart(4)} spikes ${String(total).padStart(6)} | neurons firing ${String(anyActive).padStart(6)} | ${dt.toFixed(1)} ms`,
  );
  brain.setChannelRate(ch, 0);
}

// Mixed drive: all channels at random levels, several windows back to back.
brain.reset();
let rng = 7;
const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
const t0 = performance.now();
const windows = 20;
let dnActiveSum = 0;
for (let w = 0; w < windows; w++) {
  for (let ch = 0; ch < c.channelNeurons.length; ch++) {
    brain.setChannelRate(ch, 150 * rand());
  }
  brain.resetCounts();
  brain.runMs(windowMs);
  dnActiveSum += readoutCounts(brain).filter((x) => x > 0).length;
}
const dt = (performance.now() - t0) / windows;
console.log(
  `mixed drive: ${dt.toFixed(1)} ms per ${windowMs} ms window, mean DN/MN active ${(dnActiveSum / windows).toFixed(0)}, total spikes ${brain.totalSpikes}`,
);
