import { Connectome } from "./Connectome";

// Leaky integrate-and-fire dynamics of the whole-brain Drosophila model of
// Shiu et al. 2024 (Nature, "A Drosophila computational brain model reveals
// sensorimotor processing"), with the same constants:
//
//   dv/dt = (v_0 - v + g) / t_mbr     t_mbr = 20 ms, v_0 = v_rst = -52 mV
//   dg/dt = -g / tau                   tau = 5 ms,    v_th = -45 mV
//   spike of pre -> g_post += w_syn * signed synapse count, after 1.8 ms
//   refractory period 2.2 ms, w_syn = 0.275 mV
//
// One addition to the published model: short-term synaptic depression
// (Tsodyks & Markram 1997). Each spike uses a fraction U of the presynaptic
// neuron's transmitter resource, which recovers with tau_rec. Without it the
// antennal lobe's excitatory local neurons drive each other into a
// self-sustaining seizure as soon as odor channels are on for more than a
// few milliseconds, and a game brain has its senses on all the time.
//
// Integration is exact per step. Only neurons that are away from rest are
// visited each step (an "active set"), so cost follows activity rather than
// brain size. The simulator is deterministic for a given seed.

export interface LIFParams {
  dtMs: number;
  tauMemMs: number;
  tauSynMs: number;
  thresholdMv: number; // v_th - v_0
  refractoryMs: number;
  delayMs: number;
  wSynMv: number;
  /** Fraction of synaptic resource used per spike (0 disables depression). */
  stdU: number;
  stdTauRecMs: number;
}

export const SHIU_PARAMS: LIFParams = {
  dtMs: 1,
  tauMemMs: 20,
  tauSynMs: 5,
  thresholdMv: 7,
  refractoryMs: 2.2,
  delayMs: 1.8,
  wSynMv: 0.275,
  stdU: 0.2,
  stdTauRecMs: 300,
};

/** Called once per spike while recording: (step within window, neuron). */
export type SpikeSink = (step: number, neuron: number) => void;

const REST_EPS = 1e-2;

export class LIFBrain {
  readonly n: number;
  readonly params: LIFParams;
  // Membrane potential relative to rest (mV) and synaptic drive (mV).
  readonly u: Float32Array;
  readonly g: Float32Array;
  private readonly refr: Uint8Array;
  private readonly inActive: Uint8Array;
  private active: Uint32Array;
  private nActive = 0;
  private nextActive: Uint32Array;
  /** Spikes per neuron since the last resetCounts(). */
  readonly counts: Uint16Array;
  /** Poisson rate (Hz) forced onto each sensory channel. */
  readonly channelRates: Float32Array;

  private readonly em: number;
  private readonly es: number;
  private readonly kg: number;
  private readonly refrSteps: number;
  private readonly delaySteps: number;
  private readonly wUnit: number;

  // Synaptic resource per presynaptic neuron, stored as the value right after
  // its last spike plus the step of that spike; recovery is applied lazily.
  private readonly res: Float32Array;
  private readonly stdU: Float32Array;
  private readonly lastSpike: Int32Array;
  private readonly recPerStep: number;

  // Ring of spike lists, one slot per step of synaptic delay, with the
  // efficacy each spike carries.
  private readonly ring: Uint16Array[];
  private readonly ringEff: Float32Array[];
  private readonly ringLen: Int32Array;
  private ringHead = 0;
  private rng: number;
  private totalSteps = 0;
  totalSpikes = 0;

  constructor(
    readonly connectome: Connectome,
    seed: number,
    params: Partial<LIFParams> = {},
    /** Multiplies w_syn; 1 reproduces the published model. */
    gain = 1,
  ) {
    this.params = { ...SHIU_PARAMS, ...params };
    const p = this.params;
    this.n = connectome.nSim;
    this.u = new Float32Array(this.n);
    this.g = new Float32Array(this.n);
    this.refr = new Uint8Array(this.n);
    this.inActive = new Uint8Array(this.n);
    this.active = new Uint32Array(this.n);
    this.nextActive = new Uint32Array(this.n);
    this.counts = new Uint16Array(this.n);
    this.channelRates = new Float32Array(connectome.channelNeurons.length);

    this.em = Math.exp(-p.dtMs / p.tauMemMs);
    this.es = Math.exp(-p.dtMs / p.tauSynMs);
    this.kg = (p.tauSynMs / (p.tauMemMs - p.tauSynMs)) * (this.em - this.es);
    this.refrSteps = Math.max(1, Math.round(p.refractoryMs / p.dtMs));
    this.delaySteps = Math.max(1, Math.round(p.delayMs / p.dtMs));
    this.wUnit = p.wSynMv * gain;

    this.res = new Float32Array(this.n).fill(1);
    // Sensory channel neurons carry an already rate-coded signal; they do
    // not depress (their U is 0), everything downstream does.
    this.stdU = new Float32Array(this.n).fill(p.stdU);
    for (const list of connectome.channelNeurons) {
      for (let k = 0; k < list.length; k++) this.stdU[list[k]] = 0;
    }
    this.lastSpike = new Int32Array(this.n).fill(-1_000_000);
    this.recPerStep = p.dtMs / p.stdTauRecMs;

    this.ring = [];
    this.ringEff = [];
    for (let i = 0; i <= this.delaySteps; i++) {
      this.ring.push(new Uint16Array(this.n));
      this.ringEff.push(new Float32Array(this.n));
    }
    this.ringLen = new Int32Array(this.delaySteps + 1);
    this.rng = seed >>> 0 || 0x9e3779b9;
  }

  get stepsTaken(): number {
    return this.totalSteps;
  }

  get activeCount(): number {
    return this.nActive;
  }

  setChannelRate(channel: number, hz: number): void {
    this.channelRates[channel] = hz;
  }

  resetCounts(): void {
    this.counts.fill(0);
  }

  /** Forget all activity (between games). */
  reset(): void {
    this.u.fill(0);
    this.g.fill(0);
    this.refr.fill(0);
    this.inActive.fill(0);
    this.nActive = 0;
    this.ringLen.fill(0);
    this.counts.fill(0);
    this.res.fill(1);
    this.lastSpike.fill(-1_000_000);
    this.totalSpikes = 0;
  }

  /** Transmitter resource left at `neuron` right now (1 = fully recovered). */
  resource(neuron: number): number {
    return this.recovered(neuron, this.totalSteps);
  }

  private recovered(i: number, step: number): number {
    const elapsed = (step - this.lastSpike[i]) * this.recPerStep;
    if (elapsed > 20) return 1;
    return 1 - (1 - this.res[i]) * Math.exp(-elapsed);
  }

  private rand(): number {
    // xorshift32
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  private activate(i: number): void {
    if (this.inActive[i] === 0) {
      this.inActive[i] = 1;
      this.active[this.nActive++] = i;
    }
  }

  /** Advance the brain by `steps` integration steps. */
  run(steps: number, sink?: SpikeSink): void {
    for (let s = 0; s < steps; s++) this.step(s, sink);
  }

  /** Advance by a duration in milliseconds; returns the number of steps. */
  runMs(ms: number, sink?: SpikeSink): number {
    const steps = Math.round(ms / this.params.dtMs);
    this.run(steps, sink);
    return steps;
  }

  private step(localStep: number, sink?: SpikeSink): void {
    const { u, g, refr, counts } = this;
    const c = this.connectome;
    const rowptr = c.rowptr;
    const col = c.col;
    const weight = c.weight;
    const wUnit = this.wUnit;

    // 1. Deliver spikes emitted delaySteps ago.
    const ringSize = this.delaySteps + 1;
    const deliverSlot = (this.ringHead + 1) % ringSize;
    const due = this.ring[deliverSlot];
    const dueEff = this.ringEff[deliverSlot];
    const nDue = this.ringLen[deliverSlot];
    for (let k = 0; k < nDue; k++) {
      const pre = due[k];
      const w = wUnit * dueEff[k];
      const end = rowptr[pre + 1];
      for (let e = rowptr[pre]; e < end; e++) {
        const post = col[e];
        g[post] += weight[e] * w;
        if (this.inActive[post] === 0) {
          this.inActive[post] = 1;
          this.active[this.nActive++] = post;
        }
      }
    }
    this.ringLen[deliverSlot] = 0;

    // The slot just freed receives this step's spikes.
    this.ringHead = deliverSlot;
    const out = this.ring[deliverSlot];
    const outEff = this.ringEff[deliverSlot];
    let nOut = 0;
    const stdU = this.stdU;
    const now = this.totalSteps;

    // 2. Sensory drive: Poisson spikes forced onto channel neurons.
    const dtS = this.params.dtMs / 1000;
    const chans = c.channelNeurons;
    for (let ch = 0; ch < chans.length; ch++) {
      const p = this.channelRates[ch] * dtS;
      if (p <= 0) continue;
      const list = chans[ch];
      for (let k = 0; k < list.length; k++) {
        if (this.rand() < p) {
          const i = list[k];
          if (refr[i] === 0) {
            // Mark as spiking by pushing u over threshold; handled below.
            u[i] = this.params.thresholdMv + 1;
            this.activate(i);
          }
        }
      }
    }

    // 3. Integrate the active set.
    const em = this.em;
    const es = this.es;
    const kg = this.kg;
    const th = this.params.thresholdMv;
    const act = this.active;
    const nxt = this.nextActive;
    let nNext = 0;
    for (let k = 0; k < this.nActive; k++) {
      const i = act[k];
      if (refr[i] > 0) {
        refr[i]--;
        nxt[nNext++] = i;
        continue;
      }
      let ui = u[i];
      const gi = g[i];
      if (ui <= th) {
        ui = ui * em + gi * kg;
        g[i] = gi * es;
      }
      if (ui > th) {
        u[i] = 0;
        g[i] = 0;
        refr[i] = this.refrSteps;
        const x = this.recovered(i, now);
        this.res[i] = x * (1 - stdU[i]);
        this.lastSpike[i] = now;
        outEff[nOut] = x;
        out[nOut++] = i;
        if (counts[i] < 65535) counts[i]++;
        if (sink !== undefined) sink(localStep, i);
        nxt[nNext++] = i;
        continue;
      }
      u[i] = ui;
      if (
        ui < REST_EPS &&
        ui > -REST_EPS &&
        g[i] < REST_EPS &&
        g[i] > -REST_EPS
      ) {
        u[i] = 0;
        g[i] = 0;
        this.inActive[i] = 0;
      } else {
        nxt[nNext++] = i;
      }
    }
    this.ringLen[deliverSlot] = nOut;
    this.totalSpikes += nOut;
    this.active = nxt;
    this.nextActive = act;
    this.nActive = nNext;
    this.totalSteps++;
  }
}
