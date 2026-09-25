// Train the fly's motor readout by imitation (behaviour cloning + DAgger).
//
//   npx tsx ../fly/train/train.ts collect --round 0 --games 32 --dir <work>
//   npx tsx ../fly/train/train.ts fit --dir <work> --out ../brain/readout.json
//   npx tsx ../fly/train/train.ts collect --round 1 --policy dagger --readout ../brain/readout.json ...
//
// Round 0 lets the teacher play while the connectome runs on the same senses;
// every decision stores the descending-neuron spike counts next to the
// teacher's choice. Later rounds (DAgger) let the brain act for part of the
// decisions, so the data covers the situations the fly gets itself into,
// still labelled with what the teacher would have done.
import fs from "node:fs";
import path from "node:path";
import { Difficulty } from "../../openfront/src/core/game/Game";
import { ReadoutHeadWeights, ReadoutWeights } from "../brain/Readout";
import type { FlyPolicy } from "../game/FlyExecution";
import { HEADS } from "../game/Motor";
import { N_SENSES } from "../game/Senses";
import { BatchGame, runBatch, summarize } from "./batch";
import {
  buildFeatures,
  countFeatures,
  DEFAULT_FIT,
  fitHead,
  senseFeatures,
} from "./fitReadout";
import { loadConnectomeFromDisk } from "./NodeBrainLoader";
import { readRecords, RECORD_BYTES } from "./records";

export const TRAIN_MAPS = [
  "pangaea",
  "britanniaclassic",
  "eastasia",
  "italia",
  "fourislands",
  "world",
  "caucasus",
  "korea",
  "danishstraits",
  "taiwanstrait",
  "tradersdream",
  "crimea",
];

function args(): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 3; i < process.argv.length; i += 2) {
    m.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
  }
  return m;
}

async function collect(a: Map<string, string>) {
  const dir = a.get("dir")!;
  const round = Number(a.get("round") ?? 0);
  const n = Number(a.get("games") ?? 32);
  const policy = (a.get("policy") ??
    (round === 0 ? "teacher" : "dagger")) as FlyPolicy;
  const readoutPath = a.get("readout");
  fs.mkdirSync(dir, { recursive: true });
  const games: BatchGame[] = [];
  for (let i = 0; i < n; i++) {
    const map = TRAIN_MAPS[i % TRAIN_MAPS.length];
    const lap = Math.floor(i / TRAIN_MAPS.length);
    const difficulty = [Difficulty.Easy, Difficulty.Medium, Difficulty.Hard][
      lap % 3
    ];
    // Shift bot counts and gold per lap so a map is not always paired with
    // the same settings.
    const k = i + lap;
    games.push({
      map,
      difficulty,
      bots: [60, 150, 300, 400][k % 4],
      // Every third game is a rich one (2x gold), where building and fighting
      // have to happen at the same time.
      goldMultiplier: k % 3 === 2 ? 2 : undefined,
      seed: `train-r${round}-${i}`,
      maxTicks: 9000,
      policy,
      daggerBeta: Number(a.get("beta") ?? 0.5),
      temperature: Number(a.get("temperature") ?? 0.5),
      readoutPath: readoutPath ? path.resolve(readoutPath) : undefined,
      recordPath: path.join(dir, `r${round}-${String(i).padStart(3, "0")}.bin`),
    });
  }
  const results = await runBatch(games, Number(a.get("jobs") ?? 4), (r, d, t) =>
    console.log(
      `[${d}/${t}] ${r.map} ${r.spec.difficulty}: ${r.won ? "WON" : r.alive ? "alive" : "dead"} rank ${r.rank}/${r.players} land ${(100 * r.landShare).toFixed(1)}% records ${r.records} ${Math.round(r.wallMs / 1000)}s`,
    ),
  );
  console.log(summarize(results));
  fs.writeFileSync(
    path.join(dir, `r${round}-results.json`),
    JSON.stringify(results, null, 1),
  );
}

function fit(a: Map<string, string>) {
  const dir = a.get("dir")!;
  const out = a.get("out") ?? path.join(dir, "readout.json");
  const conn = loadConnectomeFromDisk();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".bin"))
    .sort();
  const bufs = files.map((f) => fs.readFileSync(path.join(dir, f)));
  const d = readRecords(bufs, conn.readout.length);
  // Hold out whole games: every 7th file.
  const train: number[] = [];
  const val: number[] = [];
  let r = 0;
  bufs.forEach((buf, fi) => {
    const nRec = Math.floor(buf.length / RECORD_BYTES(conn.readout.length));
    for (let k = 0; k < nRec; k++, r++) (fi % 7 === 3 ? val : train).push(r);
  });
  console.log(
    `${d.n} decisions from ${files.length} games (${train.length} train / ${val.length} held out)`,
  );
  const opt = {
    ...DEFAULT_FIT,
    epochs: Number(a.get("epochs") ?? DEFAULT_FIT.epochs),
    l2: Number(a.get("l2") ?? DEFAULT_FIT.l2),
  };
  const senseFm = buildFeatures(d, train, N_SENSES, senseFeatures);
  const countFm = buildFeatures(d, train, conn.readout.length, countFeatures);
  const heads: ReadoutHeadWeights[] = [];
  const stats: Record<string, unknown> = {};
  HEADS.forEach((info, h) => {
    const head = d.heads[h];
    const dist = new Array<number>(head.nActions).fill(0);
    for (let i = 0; i < d.n; i++) dist[head.teacher[i]]++;
    console.log(
      `\n${info.label}: teacher chose ` +
        info.programs.map((x, i) => `${x.key} ${dist[i]}`).join(", "),
    );
    // Reference: the same regression straight from the senses, i.e. what a
    // readout could do if the brain passed its input through untouched.
    const ref = fitHead(senseFm, head, train, val, { ...opt, epochs: 25 });
    const res = fitHead(countFm, head, train, val, opt, console.log);
    const majority = Math.max(...dist) / d.n;
    console.log(
      `held-out accuracy: brain readout ${(100 * res.valAcc).toFixed(1)}% (train ${(100 * res.trainAcc).toFixed(1)}%), raw senses ${(100 * ref.valAcc).toFixed(1)}%, always-majority ${(100 * majority).toFixed(1)}%`,
    );
    res.perAction.forEach((q, i) =>
      console.log(
        `  ${info.programs[i].key.padEnd(10)} n=${String(q.n).padStart(5)} recall ${(100 * q.recall).toFixed(0)}%`,
      ),
    );
    const dim = conn.readout.length;
    heads.push({
      key: info.key,
      actions: info.programs.map((x) => x.key),
      W: Array.from({ length: head.nActions }, (_, i) =>
        Array.from(res.W.subarray(i * dim, (i + 1) * dim), (v) => +v.toFixed(5)),
      ),
      b: Array.from(res.b, (v) => +v.toFixed(5)),
    });
    stats[info.key] = {
      heldOutAccuracy: +res.valAcc.toFixed(4),
      trainAccuracy: +res.trainAcc.toFixed(4),
      rawSenseAccuracy: +ref.valAcc.toFixed(4),
      majorityBaseline: +majority.toFixed(4),
      perActionRecall: Object.fromEntries(
        res.perAction.map((q, i) => [info.programs[i].key, +q.recall.toFixed(3)]),
      ),
    };
  });
  let active = 0;
  for (let j = 0; j < conn.readout.length; j++) {
    if (countFm.std[j] > 1e-6) active++;
  }
  const weights: ReadoutWeights = {
    version: 2,
    brain: "flywire783",
    windowMs: 100,
    neurons: Array.from(conn.readout),
    mean: Array.from(countFm.mean, (v) => +v.toFixed(5)),
    std: Array.from(countFm.std, (v) => +v.toFixed(5)),
    heads,
    training: {
      method:
        "behaviour cloning + DAgger from a heuristic teacher (masked softmax regression per head)",
      decisions: d.n,
      games: files.length,
      readoutNeuronsThatFired: active,
      ...stats,
    },
  };
  fs.writeFileSync(out, JSON.stringify(weights));
  console.log(
    `\nwrote ${out} (${active} of ${conn.readout.length} readout neurons fired in the data)`,
  );
}

const cmd = process.argv[2];
const a = args();
console.debug = () => {};
if (cmd === "collect") await collect(a);
else if (cmd === "fit") fit(a);
else {
  console.log("usage: train.ts collect|fit --dir <work dir> [...]");
  process.exit(1);
}
