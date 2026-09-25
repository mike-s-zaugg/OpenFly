import { N_ACTIONS } from "../game/Motor";
import { Dataset } from "./records";

// Masked multinomial logistic regression from readout-neuron activity to the
// teacher's motor program, trained with mini-batch Adam. Only programs that
// were feasible at that moment compete in the softmax, the same rule the fly
// uses when it plays.

export interface FitOptions {
  epochs: number;
  batch: number;
  lr: number;
  l2: number;
  /** Class weight = (count / mean count)^-classBalance. */
  classBalance: number;
  seed: number;
}

export const DEFAULT_FIT: FitOptions = {
  epochs: 40,
  batch: 256,
  lr: 0.004,
  l2: 3e-4,
  classBalance: 0.5,
  seed: 1,
};

export interface FitResult {
  W: Float32Array; // A x D
  b: Float32Array;
  mean: Float32Array;
  std: Float32Array;
  trainAcc: number;
  valAcc: number;
  valLoss: number;
  perAction: { n: number; recall: number }[];
}

type Features = (d: Dataset, r: number, out: Float32Array) => void;

export const countFeatures: Features = (d, r, out) => {
  const off = r * d.nReadout;
  for (let j = 0; j < d.nReadout; j++) out[j] = Math.log1p(d.counts[off + j]);
};

export const senseFeatures: Features = (d, r, out) => {
  for (let j = 0; j < 13; j++) out[j] = d.senses[r * 13 + j];
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function fitReadout(
  d: Dataset,
  train: number[],
  val: number[],
  dim: number,
  feat: Features,
  opt: FitOptions = DEFAULT_FIT,
  log: (s: string) => void = () => {},
): FitResult {
  const A = N_ACTIONS;
  // Materialize standardized features.
  const X = new Float32Array(d.n * dim);
  const tmp = new Float32Array(dim);
  for (let r = 0; r < d.n; r++) {
    feat(d, r, tmp);
    X.set(tmp, r * dim);
  }
  const mean = new Float32Array(dim);
  const std = new Float32Array(dim);
  for (const r of train) for (let j = 0; j < dim; j++) mean[j] += X[r * dim + j];
  for (let j = 0; j < dim; j++) mean[j] /= train.length;
  for (const r of train) {
    for (let j = 0; j < dim; j++) {
      const v = X[r * dim + j] - mean[j];
      std[j] += v * v;
    }
  }
  for (let j = 0; j < dim; j++) std[j] = Math.sqrt(std[j] / train.length);
  for (let r = 0; r < d.n; r++) {
    for (let j = 0; j < dim; j++) {
      X[r * dim + j] = std[j] > 1e-6 ? (X[r * dim + j] - mean[j]) / std[j] : 0;
    }
  }

  const counts = new Float64Array(A);
  for (const r of train) counts[d.teacher[r]]++;
  const meanCount = train.length / A;
  const cw = Float32Array.from(counts, (c) =>
    c > 0 ? Math.pow(c / meanCount, -opt.classBalance) : 0,
  );

  const W = new Float32Array(A * dim);
  const b = new Float32Array(A);
  // Start from the log prior so the untrained model already predicts the base rates.
  for (let a = 0; a < A; a++) b[a] = Math.log((counts[a] + 1) / (train.length + A));
  const mW = new Float32Array(W.length);
  const vW = new Float32Array(W.length);
  const mb = new Float32Array(A);
  const vb = new Float32Array(A);
  const gW = new Float32Array(W.length);
  const gb = new Float32Array(A);
  const logits = new Float32Array(A);
  const p = new Float32Array(A);
  const b1 = 0.9;
  const b2 = 0.999;
  let step = 0;

  const forward = (r: number) => {
    const x = r * dim;
    const m = r * A;
    let max = -Infinity;
    for (let a = 0; a < A; a++) {
      if (d.mask[m + a] === 0) {
        logits[a] = -Infinity;
        continue;
      }
      let s = b[a];
      const row = a * dim;
      for (let j = 0; j < dim; j++) s += W[row + j] * X[x + j];
      logits[a] = s;
      if (s > max) max = s;
    }
    let sum = 0;
    for (let a = 0; a < A; a++) {
      p[a] = logits[a] === -Infinity ? 0 : Math.exp(logits[a] - max);
      sum += p[a];
    }
    for (let a = 0; a < A; a++) p[a] /= sum;
  };

  const evaluate = (rows: number[]) => {
    let correct = 0;
    let loss = 0;
    const per = Array.from({ length: A }, () => ({ n: 0, hit: 0 }));
    for (const r of rows) {
      forward(r);
      let best = 0;
      for (let a = 1; a < A; a++) if (p[a] > p[best]) best = a;
      const y = d.teacher[r];
      per[y].n++;
      if (best === y) {
        correct++;
        per[y].hit++;
      }
      loss -= Math.log(Math.max(1e-9, p[y]));
    }
    return {
      acc: correct / Math.max(1, rows.length),
      loss: loss / Math.max(1, rows.length),
      per: per.map((q) => ({ n: q.n, recall: q.n ? q.hit / q.n : 0 })),
    };
  };

  const rand = rng(opt.seed);
  const order = train.slice();
  let best = { W: W.slice(), b: b.slice(), loss: Infinity, epoch: -1 };
  for (let epoch = 0; epoch < opt.epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const k = Math.floor(rand() * (i + 1));
      [order[i], order[k]] = [order[k], order[i]];
    }
    for (let start = 0; start < order.length; start += opt.batch) {
      const end = Math.min(order.length, start + opt.batch);
      gW.fill(0);
      gb.fill(0);
      let wsum = 0;
      for (let k = start; k < end; k++) {
        const r = order[k];
        forward(r);
        const y = d.teacher[r];
        const w = cw[y];
        wsum += w;
        const x = r * dim;
        for (let a = 0; a < A; a++) {
          const g = w * (p[a] - (a === y ? 1 : 0));
          if (g === 0) continue;
          gb[a] += g;
          const row = a * dim;
          for (let j = 0; j < dim; j++) gW[row + j] += g * X[x + j];
        }
      }
      step++;
      const lrT = (opt.lr * Math.sqrt(1 - Math.pow(b2, step))) / (1 - Math.pow(b1, step));
      for (let i = 0; i < W.length; i++) {
        const g = gW[i] / wsum + opt.l2 * W[i];
        mW[i] = b1 * mW[i] + (1 - b1) * g;
        vW[i] = b2 * vW[i] + (1 - b2) * g * g;
        W[i] -= (lrT * mW[i]) / (Math.sqrt(vW[i]) + 1e-8);
      }
      for (let a = 0; a < A; a++) {
        const g = gb[a] / wsum;
        mb[a] = b1 * mb[a] + (1 - b1) * g;
        vb[a] = b2 * vb[a] + (1 - b2) * g * g;
        b[a] -= (lrT * mb[a]) / (Math.sqrt(vb[a]) + 1e-8);
      }
    }
    const ev = evaluate(val);
    if (ev.loss < best.loss) best = { W: W.slice(), b: b.slice(), loss: ev.loss, epoch };
    if (epoch % 5 === 4 || epoch === opt.epochs - 1) {
      log(`  epoch ${epoch + 1}: val loss ${ev.loss.toFixed(3)} acc ${(100 * ev.acc).toFixed(1)}%`);
    }
  }
  W.set(best.W);
  b.set(best.b);
  const tr = evaluate(train);
  const va = evaluate(val);
  log(`  best epoch ${best.epoch + 1}`);
  return {
    W,
    b,
    mean,
    std,
    trainAcc: tr.acc,
    valAcc: va.acc,
    valLoss: va.loss,
    perAction: va.per,
  };
}
