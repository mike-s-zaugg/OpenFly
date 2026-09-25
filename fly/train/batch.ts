import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Difficulty } from "../../openfront/src/core/game/Game";
import type { FlyPolicy } from "../game/FlyExecution";
import type { GameResult } from "./HeadlessGame";
import { OPENFLY_ROOT } from "./NodeBrainLoader";

// Runs many headless games in parallel child processes.

export interface BatchGame {
  map: string;
  difficulty: Difficulty;
  bots: number;
  seed: string;
  maxTicks: number;
  compact?: boolean;
  policy: FlyPolicy;
  daggerBeta?: number;
  temperature?: number;
  readoutPath?: string;
  recordPath?: string;
}

export type BatchResult = GameResult & { records: number; spec: BatchGame };

export async function runBatch(
  games: BatchGame[],
  concurrency = Math.max(1, os.cpus().length),
  onDone?: (r: BatchResult, done: number, total: number) => void,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  let next = 0;
  let done = 0;
  const worker = path.join(OPENFLY_ROOT, "fly/train/gameWorker.ts");
  const runOne = (g: BatchGame) =>
    new Promise<BatchResult>((resolve, reject) => {
      const spec = {
        map: g.map,
        difficulty: g.difficulty,
        bots: g.bots,
        seed: g.seed,
        maxTicks: g.maxTicks,
        compact: g.compact,
        readoutPath: g.readoutPath,
        recordPath: g.recordPath,
        fly: {
          policy: g.policy,
          daggerBeta: g.daggerBeta ?? 0.5,
          temperature: g.temperature ?? 0,
        },
      };
      const child = spawn(
        process.execPath,
        ["--import", "tsx", worker, JSON.stringify(spec)],
        {
          cwd: path.join(OPENFLY_ROOT, "openfront"),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        const line = out.split("\n").find((l) => l.startsWith("RESULT "));
        if (code !== 0 || line === undefined) {
          reject(
            new Error(`game ${g.seed} failed (${code}): ${err.slice(-2000)}`),
          );
          return;
        }
        resolve({
          ...(JSON.parse(line.slice(7)) as GameResult & { records: number }),
          spec: g,
        });
      });
    });
  const lanes = Array.from(
    { length: Math.min(concurrency, games.length) },
    async () => {
      while (next < games.length) {
        const g = games[next++];
        try {
          const r = await runOne(g);
          results.push(r);
          done++;
          onDone?.(r, done, games.length);
        } catch (e) {
          done++;
          console.error(String(e));
        }
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

export function summarize(results: BatchResult[]): string {
  const n = results.length;
  if (n === 0) return "no games";
  const mean = (f: (r: BatchResult) => number) =>
    results.reduce((a, r) => a + f(r), 0) / n;
  return [
    `games ${n}`,
    `won ${results.filter((r) => r.won).length}`,
    `alive ${results.filter((r) => r.alive).length}`,
    `top3 ${results.filter((r) => r.alive && r.rank <= 3).length}`,
    `mean rank ${mean((r) => r.rank).toFixed(1)} of ${mean((r) => r.players).toFixed(1)}`,
    `mean final land ${(100 * mean((r) => r.landShare)).toFixed(1)}%`,
    `mean peak land ${(100 * mean((r) => r.peakLandShare)).toFixed(1)}%`,
  ].join(" | ");
}
