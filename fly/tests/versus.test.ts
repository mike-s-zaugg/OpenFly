import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Difficulty,
  Execution,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
} from "../../openfront/src/core/game/Game";
import { createGameRunner } from "../../openfront/src/core/GameRunner";
import { GameStartInfo } from "../../openfront/src/core/Schemas";
import { NodeGameMapLoader } from "../../openfront/tests/perf/fullgame/NodeGameMapLoader";
import { FlyExecution } from "../game/FlyExecution";
import { FlyRegistry } from "../game/FlyRegistry";
import { loadConnectomeFromDisk, OPENFLY_ROOT } from "../train/NodeBrainLoader";

beforeAll(() => {
  FlyRegistry.setConnectome(loadConnectomeFromDisk());
  console.log = () => {};
});

describe("versus mode", () => {
  it("gives nations fly brains through OpenFront's own game setup", async () => {
    const clientID = "HUMAN001";
    const gameStart = {
      gameID: "versus-test",
      lobbyCreatedAt: 0,
      players: [{ clientID, username: "Human", clanTag: null, cosmetics: {} }],
      config: {
        gameMap: GameMapType.Pangaea,
        gameMapSize: GameMapSize.Compact,
        gameMode: GameMode.FFA,
        gameType: GameType.Singleplayer,
        difficulty: Difficulty.Easy,
        nations: "default",
        donateGold: false,
        donateTroops: false,
        bots: 10,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
        openfly: { mode: "versus", maxFlies: 2, policy: "teacher" },
      },
    } as GameStartInfo;
    const loader = new NodeGameMapLoader(
      path.join(OPENFLY_ROOT, "openfront/resources/maps"),
    );
    const runner = await createGameRunner(
      gameStart,
      clientID,
      loader,
      () => {},
    );
    const game = runner.game;
    let turn = 0;
    for (let t = 0; t < 400; t++) {
      // The human lands on tick 5, which ends the singleplayer spawn phase.
      const intents =
        t === 5
          ? [{ type: "spawn" as const, clientID, tile: game.ref(100, 100) }]
          : [];
      runner.addTurn({ turnNumber: turn++, intents });
      runner.executeNextTick();
    }
    const flies = (game as unknown as { executions(): Execution[] })
      .executions()
      .filter((e): e is FlyExecution => e instanceof FlyExecution);
    expect(flies).toHaveLength(2);
    for (const f of flies) {
      const p = f.flyPlayer()!;
      expect(p.type()).toBe(PlayerType.Nation);
      expect(p.isAlive()).toBe(true);
      expect(p.numTilesOwned()).toBeGreaterThan(100);
      expect(f.decisions).toBeGreaterThan(5);
    }
  });
});
