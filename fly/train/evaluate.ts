// Evaluate a fly policy over a fixed suite of singleplayer games.
//   npx tsx ../fly/train/evaluate.ts --policy brain --readout ../brain/readout.json
//     [--suite quick|standard] [--out results.json] [--seed-prefix eval]
import fs from "node:fs";
import { Difficulty } from "../../openfront/src/core/game/Game";
import type { FlyPolicy } from "../game/FlyExecution";
import { BatchGame, runBatch, summarize } from "./batch";

export const EVAL_MAPS = [
  "pangaea",
  "world",
  "britanniaclassic",
  "eastasia",
  "italia",
  "fourislands",
];

export function suite(
  name: string,
  policy: FlyPolicy,
  readoutPath: string | undefined,
  prefix: string,
): BatchGame[] {
  const games: BatchGame[] = [];
  const diffs =
    name === "quick" ? [Difficulty.Easy] : [Difficulty.Easy, Difficulty.Medium];
  const seeds = name === "quick" ? 1 : 2;
  for (const map of name === "quick" ? EVAL_MAPS.slice(0, 4) : EVAL_MAPS) {
    for (const difficulty of diffs) {
      for (let s = 0; s < seeds; s++) {
        games.push({
          map,
          difficulty,
          bots: 150,
          seed: `${prefix}-${map}-${difficulty}-${s}`,
          maxTicks: 9000,
          policy,
          readoutPath,
        });
      }
    }
  }
  return games;
}

async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
  }
  const policy = (args.get("policy") ?? "brain") as FlyPolicy;
  const games = suite(
    args.get("suite") ?? "standard",
    policy,
    args.get("readout"),
    args.get("seed-prefix") ?? "eval",
  );
  console.log(`evaluating ${policy} on ${games.length} games`);
  const results = await runBatch(
    games,
    Number(args.get("jobs") ?? 4),
    (r, d, t) =>
      console.log(
        `[${d}/${t}] ${r.map} ${r.spec.difficulty}: ${r.won ? "WON" : r.alive ? "alive" : "dead"} rank ${r.rank}/${r.players} land ${(100 * r.landShare).toFixed(1)}% (peak ${(100 * r.peakLandShare).toFixed(1)}%) ${Math.round(r.wallMs / 1000)}s`,
      ),
  );
  console.log(summarize(results));
  for (const diff of [Difficulty.Easy, Difficulty.Medium]) {
    const sub = results.filter((r) => r.spec.difficulty === diff);
    if (sub.length > 0) console.log(`  ${diff}: ${summarize(sub)}`);
  }
  if (args.has("out")) {
    fs.writeFileSync(args.get("out")!, JSON.stringify(results, null, 1));
  }
}

if (process.argv[1]?.endsWith("evaluate.ts")) {
  await main();
}
