// Play one game and print the fly's state once per game minute.
//   npx tsx ../fly/train/diagnose.ts --map world --difficulty Medium --gold 2 --policy brain
import fs from "node:fs";
import { Difficulty, UnitType } from "../../openfront/src/core/game/Game";
import { Readout, ReadoutWeights } from "../brain/Readout";
import { FlyPolicy } from "../game/FlyExecution";
import { FlyRegistry } from "../game/FlyRegistry";
import { ECONOMY, MILITARY } from "../game/Motor";
import { createHeadlessGame } from "./HeadlessGame";
import { loadConnectomeFromDisk, OPENFLY_ROOT } from "./NodeBrainLoader";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
console.debug = () => {};
console.log = ((orig) =>
  (...a: unknown[]) => {
    if (typeof a[0] === "string" && /won the game|Constructor|cannot build/.test(a[0])) return;
    orig(...a);
  })(console.log);
console.warn = () => {};

FlyRegistry.setConnectome(loadConnectomeFromDisk());
const readoutPath = args.get("readout") ?? `${OPENFLY_ROOT}/brain/readout.json`;
if ((args.get("policy") ?? "brain") !== "teacher") {
  FlyRegistry.setReadout(
    new Readout(
      JSON.parse(fs.readFileSync(readoutPath, "utf8")) as ReadoutWeights,
    ),
  );
}
const h = await createHeadlessGame({
  map: args.get("map") ?? "world",
  difficulty: (args.get("difficulty") as Difficulty) ?? Difficulty.Medium,
  bots: Number(args.get("bots") ?? 400),
  goldMultiplier: args.has("gold") ? Number(args.get("gold")) : undefined,
  seed: args.get("seed") ?? "diag-1",
  maxTicks: Number(args.get("ticks") ?? 18000),
  fly: {
    policy: (args.get("policy") as FlyPolicy) ?? "brain",
    teacherParams: args.has("teacher")
      ? (JSON.parse(args.get("teacher")!) as Record<string, number>)
      : undefined,
  },
});
const maxTicks = Number(args.get("ticks") ?? 18000);
let lastMil = h.fly.milCounts.slice();
let lastEco = h.fly.ecoCounts.slice();
const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${Math.round(n)}`;
while (h.game.ticks() < maxTicks) {
  h.step();
  const t = h.game.ticks();
  const me = h.fly.flyPlayer();
  if (me === null || !me.hasSpawned() || h.game.inSpawnPhase()) continue;
  if (t % 600 === 0 || !me.isAlive() || h.game.getWinner() !== null) {
    const cfg = h.game.config();
    const fmtDelta = (names: { key: string }[], now: number[], before: number[]) =>
      names
        .map((a, i) => [a.key, now[i] - before[i]] as const)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}:${n}`)
        .join(" ");
    const delta =
      fmtDelta(MILITARY, h.fly.milCounts, lastMil) + " / " + fmtDelta(ECONOMY, h.fly.ecoCounts, lastEco);
    lastMil = h.fly.milCounts.slice();
    lastEco = h.fly.ecoCounts.slice();
    const ranked = h.game.players().filter((p) => p.isAlive()).sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
    const nukesIn = h.game
      .units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRVWarhead)
      .filter((u) => u.owner() !== me && u.targetTile() !== undefined && h.game.owner(u.targetTile()!) === me).length;
    const attackers = me.incomingAttacks().length;
    const top = ranked.slice(0, 3).map((p) => `${p.name()} ${fmt(p.troops())}`).join(", ");
    console.log(
      `${Math.floor(t / 600)}m rank ${ranked.indexOf(me) + 1}/${ranked.length} land ${(100 * me.numTilesOwned() / h.game.totalLandTiles()).toFixed(1)}% ` +
        `troops ${fmt(me.troops())}/${fmt(cfg.maxTroops(me))} gold ${fmt(Number(me.gold()))} ` +
        `cities ${me.unitCount(UnitType.City)} ports ${me.unitCount(UnitType.Port)} fact ${me.unitCount(UnitType.Factory)} sam ${me.unitCount(UnitType.SAMLauncher)} silo ${me.unitCount(UnitType.MissileSilo)} ` +
        `| inAttacks ${attackers} nukesIn ${nukesIn} allies ${me.allies().length} | ${delta} | top: ${top}`,
    );
    if (!me.isAlive() || h.game.getWinner() !== null) break;
  }
}
