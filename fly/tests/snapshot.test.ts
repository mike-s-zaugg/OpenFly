import { beforeAll, describe, expect, it } from "vitest";
import { Config } from "../../openfront/src/core/configuration/Config";
import { Execution } from "../../openfront/src/core/game/Game";
import { restoreGame, snapshotGame } from "../../openfront/src/core/snapshot/GameSnapshot";
import { FlyExecution } from "../game/FlyExecution";
import { FlyRegistry } from "../game/FlyRegistry";
import { createHeadlessGame, loadHeadlessTerrain } from "../train/HeadlessGame";
import { loadConnectomeFromDisk } from "../train/NodeBrainLoader";

beforeAll(() => {
  FlyRegistry.setConnectome(loadConnectomeFromDisk());
  console.log = () => {};
});

describe("fly snapshots", () => {
  it("survive a snapshot round trip and keep playing", async () => {
    const h = await createHeadlessGame({
      map: "pangaea",
      compact: true,
      bots: 10,
      seed: "fly-snapshot",
      maxTicks: 0,
      fly: { policy: "teacher" },
    });
    for (let i = 0; i < 300; i++) h.step();
    expect(h.fly.decisions).toBeGreaterThan(0);

    const bytes = snapshotGame(h.game, { gameID: "fly-snapshot" });
    const terrain = await loadHeadlessTerrain(h.gameConfig);
    const restored = restoreGame(bytes, {
      config: (gc) => new Config(gc, null, false),
      gameMap: terrain.gameMap,
      miniGameMap: terrain.miniGameMap,
      teamGameSpawnAreas: terrain.teamGameSpawnAreas,
    });
    const flies = (restored as unknown as { executions(): Execution[] })
      .executions()
      .filter((e): e is FlyExecution => e instanceof FlyExecution);
    expect(flies).toHaveLength(1);
    const fly = flies[0];
    expect(fly.isActive()).toBe(true);
    expect(fly.flyPlayer()?.isAlive()).toBe(true);
    for (let i = 0; i < 60; i++) restored.executeNextTick();
    expect(fly.decisions).toBeGreaterThan(0);
  });
});
