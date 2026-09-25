// Play one headless game and print the result.
//   npx tsx ../fly/train/play.ts --map pangaea --policy teacher --ticks 9000
import fs from "node:fs";
import { Difficulty } from "../../openfront/src/core/game/Game";
import { Readout, ReadoutWeights } from "../brain/Readout";
import { FlyRegistry } from "../game/FlyRegistry";
import { ECONOMY, MILITARY } from "../game/Motor";
import { playHeadless } from "./HeadlessGame";
import { loadConnectomeFromDisk } from "./NodeBrainLoader";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
console.debug = () => {};
console.log = (
  (orig) =>
  (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].includes("has won the game")) return;
    orig(...a);
  }
)(console.log);

FlyRegistry.setConnectome(loadConnectomeFromDisk());
if (args.has("readout")) {
  FlyRegistry.setReadout(
    new Readout(
      JSON.parse(
        fs.readFileSync(args.get("readout")!, "utf8"),
      ) as ReadoutWeights,
    ),
  );
}
const res = await playHeadless({
  map: args.get("map") ?? "pangaea",
  compact: args.get("compact") === "1",
  difficulty: (args.get("difficulty") as Difficulty) ?? Difficulty.Easy,
  bots: Number(args.get("bots") ?? 100),
  seed: args.get("seed") ?? "play-1",
  maxTicks: Number(args.get("ticks") ?? 9000),
  fly: { policy: (args.get("policy") as "brain") ?? "teacher" },
});
console.log(
  JSON.stringify(
    {
      ...res,
      actionCounts: Object.fromEntries(
        [...MILITARY.map((a, i) => [a.key, res.actionCounts.military[i]]),
         ...ECONOMY.map((a, i) => [a.key, res.actionCounts.economy[i]])],
      ),
    },
    null,
    1,
  ),
);
