// Linear readouts from the fly's descending (and brain motor) neurons to its
// motor programs. There are two heads, military and economy, reading the same
// neurons in parallel: score_a = b_a + sum_j W_aj * z_j, where z_j is the
// standardized log spike count of readout neuron j over one decision window.
// Within a head, only programs the body can currently run compete
// (feasibility mask).

export interface ReadoutHeadWeights {
  key: string;
  actions: string[];
  /** W[action][neuron] */
  W: number[][];
  b: number[];
}

export interface ReadoutWeights {
  version: 2;
  brain: string;
  windowMs: number;
  /** Readout neuron indices into the simulated brain, same order as W columns. */
  neurons: number[];
  mean: number[];
  std: number[];
  heads: ReadoutHeadWeights[];
  training?: Record<string, unknown>;
}

interface Head {
  key: string;
  nOut: number;
  W: Float32Array;
  b: Float32Array;
}

export class Readout {
  readonly nIn: number;
  readonly neurons: Uint16Array;
  private readonly heads: Head[];
  private readonly mean: Float32Array;
  private readonly invStd: Float32Array;
  private readonly z: Float32Array;

  constructor(readonly weights: ReadoutWeights) {
    if (weights.version !== 2) {
      throw new Error(
        `OpenFly: readout format ${String(weights.version)} is outdated; retrain (fly/train/train.ts)`,
      );
    }
    this.nIn = weights.neurons.length;
    this.neurons = Uint16Array.from(weights.neurons);
    this.mean = Float32Array.from(weights.mean);
    this.invStd = Float32Array.from(weights.std, (s) => (s > 1e-6 ? 1 / s : 0));
    this.z = new Float32Array(this.nIn);
    this.heads = weights.heads.map((h) => {
      const W = new Float32Array(this.nIn * h.actions.length);
      for (let a = 0; a < h.actions.length; a++) {
        for (let j = 0; j < this.nIn; j++) W[a * this.nIn + j] = h.W[a][j];
      }
      return { key: h.key, nOut: h.actions.length, W, b: Float32Array.from(h.b) };
    });
  }

  /** Readout input features from raw brain spike counts. */
  static features(
    counts: Uint16Array,
    neurons: Uint16Array,
    out: Float32Array,
  ): Float32Array {
    for (let j = 0; j < neurons.length; j++) {
      out[j] = Math.log1p(counts[neurons[j]]);
    }
    return out;
  }

  /** Scores for every head, from one window's spike counts. */
  scores(counts: Uint16Array): Float32Array[] {
    const z = Readout.features(counts, this.neurons, this.z);
    for (let j = 0; j < this.nIn; j++) {
      z[j] = (z[j] - this.mean[j]) * this.invStd[j];
    }
    return this.heads.map((h) => {
      const out = new Float32Array(h.nOut);
      for (let a = 0; a < h.nOut; a++) {
        let s = h.b[a];
        const row = a * this.nIn;
        for (let j = 0; j < this.nIn; j++) s += h.W[row + j] * z[j];
        out[a] = s;
      }
      return out;
    });
  }
}

export function maskedArgmax(scores: Float32Array, mask: Uint8Array): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let a = 0; a < scores.length; a++) {
    if (mask[a] === 0) continue;
    if (scores[a] > bestScore) {
      bestScore = scores[a];
      best = a;
    }
  }
  return best;
}

/** Softmax over feasible actions (probabilities; infeasible = 0). */
export function maskedSoftmax(
  scores: Float32Array,
  mask: Uint8Array,
  out = new Float32Array(scores.length),
): Float32Array {
  let max = -Infinity;
  for (let a = 0; a < scores.length; a++) {
    if (mask[a] && scores[a] > max) max = scores[a];
  }
  let sum = 0;
  for (let a = 0; a < scores.length; a++) {
    out[a] = mask[a] ? Math.exp(scores[a] - max) : 0;
    sum += out[a];
  }
  for (let a = 0; a < scores.length; a++) out[a] /= sum || 1;
  return out;
}
