// Linear readout from the fly's descending (and brain motor) neurons to the
// motor programs: score_a = b_a + sum_j W_aj * z_j, where z_j is the
// standardized log spike count of readout neuron j over one decision window.
// Only programs the body can currently run compete (feasibility mask).

export interface ReadoutWeights {
  version: 1;
  brain: string;
  windowMs: number;
  actions: string[];
  /** Readout neuron indices into the simulated brain, same order as W rows. */
  neurons: number[];
  mean: number[];
  std: number[];
  /** W[action][neuron] */
  W: number[][];
  b: number[];
  training?: Record<string, unknown>;
}

export class Readout {
  readonly nIn: number;
  readonly nOut: number;
  private readonly W: Float32Array;
  private readonly b: Float32Array;
  private readonly mean: Float32Array;
  private readonly invStd: Float32Array;
  readonly neurons: Uint16Array;
  private readonly z: Float32Array;

  constructor(readonly weights: ReadoutWeights) {
    this.nIn = weights.neurons.length;
    this.nOut = weights.actions.length;
    this.neurons = Uint16Array.from(weights.neurons);
    this.W = new Float32Array(this.nIn * this.nOut);
    for (let a = 0; a < this.nOut; a++) {
      for (let j = 0; j < this.nIn; j++) this.W[a * this.nIn + j] = weights.W[a][j];
    }
    this.b = Float32Array.from(weights.b);
    this.mean = Float32Array.from(weights.mean);
    this.invStd = Float32Array.from(weights.std, (s) => (s > 1e-6 ? 1 / s : 0));
    this.z = new Float32Array(this.nIn);
  }

  /** Readout input features from raw brain spike counts. */
  static features(counts: Uint16Array, neurons: Uint16Array, out: Float32Array): Float32Array {
    for (let j = 0; j < neurons.length; j++) out[j] = Math.log1p(counts[neurons[j]]);
    return out;
  }

  scores(counts: Uint16Array, out = new Float32Array(this.nOut)): Float32Array {
    const z = Readout.features(counts, this.neurons, this.z);
    for (let j = 0; j < this.nIn; j++) z[j] = (z[j] - this.mean[j]) * this.invStd[j];
    for (let a = 0; a < this.nOut; a++) {
      let s = this.b[a];
      const row = a * this.nIn;
      for (let j = 0; j < this.nIn; j++) s += this.W[row + j] * z[j];
      out[a] = s;
    }
    return out;
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
  for (let a = 0; a < scores.length; a++) if (mask[a] && scores[a] > max) max = scores[a];
  let sum = 0;
  for (let a = 0; a < scores.length; a++) {
    out[a] = mask[a] ? Math.exp(scores[a] - max) : 0;
    sum += out[a];
  }
  for (let a = 0; a < scores.length; a++) out[a] /= sum || 1;
  return out;
}
