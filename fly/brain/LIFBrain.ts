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
// Integration is exact. A neuron is only integrated step by step while it is
// "hot": refractory, or with enough voltage plus synaptic drive that it could
// still reach threshold without further input. Every other neuron is "cold":
// its state is left alone and caught up in one exact jump (precomputed decay
// powers) when its next input arrives. Cost therefore follows spikes and
// near-threshold neurons rather than brain size. The simulator is
// deterministic for a given seed.

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

/** Beyond this many steps without input a cold neuron has fully decayed. */
const MAX_JUMP = 400;

export class LIFBrain {
  readonly n: number;
  readonly params: LIFParams;
  // Membrane potential relative to rest (mV) and synaptic drive (mV). For a
  // cold neuron these hold the state at the start of step `last[i]`.
  readonly u: Float32Array;
  readonly g: Float32Array;
  private readonly refr: Uint8Array;
  private readonly last: Int32Array;
  private readonly hot: Uint8Array;
  private hotList: Uint32Array;
  private nHot = 0;
  private nextHot: Uint32Array;
  private readonly touchedAt: Int32Array;
  private readonly touched: Uint32Array;
  /** Input collected this step, added to g once per touched neuron. */
  private readonly inbox: Float32Array;
  /** Signed synapse counts times w_syn (mV per spike at full resource). */
  private readonly weightMv: Float32Array;
  /** Spikes per neuron since the last resetCounts(). */
  readonly counts: Uint16Array;
  /** Poisson rate (Hz) forced onto each sensory channel. */
  readonly channelRates: Float32Array;

  private readonly em: number;
  private readonly es: number;
  private readonly kg: number;
  /** tau_s / (tau_m - tau_s): u can never exceed max(u,0) + c*max(g,0). */
  private readonly cBound: number;
  private readonly emPow: Float32Array;
  private readonly esPow: Float32Array;
  private readonly kPow: Float32Array;
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
    this.last = new Int32Array(this.n);
    this.hot = new Uint8Array(this.n);
    this.hotList = new Uint32Array(this.n);
    this.nextHot = new Uint32Array(this.n);
    this.touchedAt = new Int32Array(this.n).fill(-1);
    this.touched = new Uint32Array(this.n);
    this.inbox = new Float32Array(this.n);
    this.counts = new Uint16Array(this.n);
    this.channelRates = new Float32Array(connectome.channelNeurons.length);

    this.em = Math.exp(-p.dtMs / p.tauMemMs);
    this.es = Math.exp(-p.dtMs / p.tauSynMs);
    this.cBound = p.tauSynMs / (p.tauMemMs - p.tauSynMs);
    this.kg = this.cBound * (this.em - this.es);
    this.emPow = new Float32Array(MAX_JUMP + 1);
    this.esPow = new Float32Array(MAX_JUMP + 1);
    this.kPow = new Float32Array(MAX_JUMP + 1);
    for (let d = 0; d <= MAX_JUMP; d++) {
      const em = Math.pow(this.em, d);
      const es = Math.pow(this.es, d);
      this.emPow[d] = em;
      this.esPow[d] = es;
      this.kPow[d] = this.cBound * (em - es);
    }
    this.refrSteps = Math.max(1, Math.round(p.refractoryMs / p.dtMs));
    this.delaySteps = Math.max(1, Math.round(p.delayMs / p.dtMs));
    this.wUnit = p.wSynMv * gain;
    this.weightMv = Float32Array.from(connectome.weight, (w) => w * this.wUnit);

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

  /** Neurons currently integrated step by step. */
  get activeCount(): number {
    return this.nHot;
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
    this.last.fill(this.totalSteps);
    this.hot.fill(0);
    this.nHot = 0;
    this.touchedAt.fill(-1);
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

  /** Bring a cold neuron's state forward to the start of step `now`. */
  private catchUp(i: number, now: number): void {
    const d = now - this.last[i];
    if (d > 0) {
      if (d > MAX_JUMP) {
        this.u[i] = 0;
        this.g[i] = 0;
      } else {
        const gi = this.g[i];
        this.u[i] = this.u[i] * this.emPow[d] + gi * this.kPow[d];
        this.g[i] = gi * this.esPow[d];
      }
    }
    this.last[i] = now;
  }

  private makeHot(i: number): void {
    if (this.hot[i] === 0) {
      this.hot[i] = 1;
      this.hotList[this.nHot++] = i;
    }
  }

  /**
   * Advance the brain by `steps` integration steps. `stepOffset` numbers the
   * steps for the spike sink when one window is simulated in several calls.
   */
  run(steps: number, sink?: SpikeSink, stepOffset = 0): void {
    for (let s = 0; s < steps; s++) this.step(stepOffset + s, sink);
  }

  /** Advance by a duration in milliseconds; returns the number of steps. */
  runMs(ms: number, sink?: SpikeSink): number {
    const steps = Math.round(ms / this.params.dtMs);
    this.run(steps, sink);
    return steps;
  }

  private step(localStep: number, sink?: SpikeSink): void {
    const { u, g, refr, counts, hot, last, touchedAt, touched, inbox } = this;
    const c = this.connectome;
    const rowptr = c.rowptr;
    const col = c.col;
    const weight = this.weightMv;
    const now = this.totalSteps;
    const th = this.params.thresholdMv;
    const cb = this.cBound;
    let nTouched = 0;

    // 1. Deliver spikes emitted delaySteps ago.
    const ringSize = this.delaySteps + 1;
    const deliverSlot = (this.ringHead + 1) % ringSize;
    const due = this.ring[deliverSlot];
    const dueEff = this.ringEff[deliverSlot];
    const nDue = this.ringLen[deliverSlot];
    for (let k = 0; k < nDue; k++) {
      const pre = due[k];
      const eff = dueEff[k];
      const end = rowptr[pre + 1];
      for (let e = rowptr[pre]; e < end; e++) {
        const post = col[e];
        inbox[post] += weight[e] * eff;
        if (touchedAt[post] !== now) {
          touchedAt[post] = now;
          touched[nTouched++] = post;
        }
      }
    }
    this.ringLen[deliverSlot] = 0;
    for (let k = 0; k < nTouched; k++) {
      const i = touched[k];
      if (hot[i] === 0) this.catchUp(i, now);
      g[i] += inbox[i];
      inbox[i] = 0;
    }

    // The slot just freed receives this step's spikes.
    this.ringHead = deliverSlot;
    const out = this.ring[deliverSlot];
    const outEff = this.ringEff[deliverSlot];
    let nOut = 0;
    const stdU = this.stdU;

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
            if (hot[i] === 0) this.catchUp(i, now);
            // Mark as spiking by pushing u over threshold; handled below.
            u[i] = th + 1;
            this.makeHot(i);
          }
        }
      }
    }

    // 3. Cold neurons that just got input join the hot set if they could
    //    now reach threshold on their own.
    for (let k = 0; k < nTouched; k++) {
      const i = touched[k];
      if (hot[i] !== 0) continue;
      const ui = u[i];
      const gi = g[i];
      if ((ui > 0 ? ui : 0) + (gi > 0 ? cb * gi : 0) > th) this.makeHot(i);
    }

    // 4. Integrate the hot set.
    const em = this.em;
    const es = this.es;
    const kg = this.kg;
    const act = this.hotList;
    const nxt = this.nextHot;
    let nNext = 0;
    for (let k = 0; k < this.nHot; k++) {
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
      const gn = g[i];
      if ((ui > 0 ? ui : 0) + (gn > 0 ? cb * gn : 0) > th) {
        nxt[nNext++] = i;
      } else {
        // Cannot fire without new input: go cold, state valid from next step.
        hot[i] = 0;
        last[i] = now + 1;
      }
    }
    this.ringLen[deliverSlot] = nOut;
    this.totalSpikes += nOut;
    this.hotList = nxt;
    this.nextHot = act;
    this.nHot = nNext;
    this.totalSteps++;
  }
}
