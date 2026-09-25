import path from "node:path";
import { Config } from "../../openfront/src/core/configuration/Config";
import { Executor } from "../../openfront/src/core/execution/ExecutionManager";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
} from "../../openfront/src/core/game/Game";
import { createGame } from "../../openfront/src/core/game/GameImpl";
import { createNationsForGame } from "../../openfront/src/core/game/NationCreation";
import { loadTerrainMap } from "../../openfront/src/core/game/TerrainMapLoader";
import { GameRunner } from "../../openfront/src/core/GameRunner";
import { PseudoRandom } from "../../openfront/src/core/PseudoRandom";
import { GameConfig, GameStartInfo } from "../../openfront/src/core/Schemas";
import { simpleHash } from "../../openfront/src/core/Util";
import { NodeGameMapLoader } from "../../openfront/tests/perf/fullgame/NodeGameMapLoader";
import { FlyExecution, FlyOptions } from "../game/FlyExecution";
import { OPENFLY_ROOT } from "./NodeBrainLoader";

// Runs a singleplayer FFA game in Node with the fly possessing the human
// player slot, exactly as in the browser's spectate mode.

export interface HeadlessGameSpec {
  map: string;
  compact?: boolean;
  difficulty?: Difficulty;
  bots?: number;
  nations?: "default" | "disabled" | number;
  seed: string;
  maxTicks: number;
  fly: Partial<FlyOptions>;
}

export interface GameResult {
  seed: string;
  map: string;
  ticks: number;
  alive: boolean;
  landShare: number;
  peakLandShare: number;
  rank: number;
  players: number;
  won: boolean;
  winner: string | null;
  decisions: number;
  actionCounts: number[];
  brainMs: number;
  wallMs: number;
}

const mapLoader = new NodeGameMapLoader(
  path.join(OPENFLY_ROOT, "openfront/resources/maps"),
);

export function resolveMap(name: string): GameMapType {
  const key = Object.keys(GameMapType).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  if (key === undefined) throw new Error(`unknown map ${name}`);
  return GameMapType[key as keyof typeof GameMapType];
}

export interface HeadlessGame {
  game: Game;
  runner: GameRunner;
  fly: FlyExecution;
  gameConfig: GameConfig;
  /** Runs one tick; throws if the simulation reports an error. */
  step(): void;
}

export async function createHeadlessGame(
  spec: HeadlessGameSpec,
): Promise<HeadlessGame> {
  const gameConfig: GameConfig = {
    gameMap: resolveMap(spec.map),
    gameMapSize: spec.compact ? GameMapSize.Compact : GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: spec.difficulty ?? Difficulty.Easy,
    nations: spec.nations ?? "default",
    donateGold: false,
    donateTroops: false,
    bots: spec.bots ?? 100,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  };
  const clientID = "FLYCLNT1";
  const gameStart: GameStartInfo = {
    gameID: spec.seed,
    lobbyCreatedAt: 0,
    config: gameConfig,
    players: [{ clientID, username: "Fly", clanTag: null, cosmetics: {} }],
  } as GameStartInfo;

  const config = new Config(gameConfig, null, false);
  const terrain = await loadHeadlessTerrain(gameConfig);
  const random = new PseudoRandom(simpleHash(gameStart.gameID));
  const human = new PlayerInfo(
    "Fly",
    PlayerType.Human,
    clientID,
    random.nextID(),
  );
  const nations = createNationsForGame(
    gameStart,
    terrain.nations,
    terrain.additionalNations,
    1,
    random,
  );
  const game = createGame(
    [human],
    nations,
    terrain.gameMap,
    terrain.miniGameMap,
    config,
    terrain.teamGameSpawnAreas,
  );
  let fatal: string | null = null;
  const runner = new GameRunner(
    game,
    new Executor(game, gameStart.gameID, clientID),
    (gu) => {
      if ("errMsg" in gu) fatal = gu.errMsg;
    },
  );
  runner.init();
  const fly = new FlyExecution(human, gameStart.gameID, spec.fly);
  game.addExecution(fly);
  let turn = 0;
  return {
    game,
    runner,
    fly,
    gameConfig,
    step() {
      runner.addTurn({ turnNumber: turn++, intents: [] });
      const ok = runner.executeNextTick();
      if (!ok || fatal !== null) {
        throw new Error(
          `game ${spec.seed} errored at tick ${game.ticks()}: ${fatal}`,
        );
      }
    },
  };
}

export function loadHeadlessTerrain(gameConfig: GameConfig) {
  // A fresh, unshared copy: the game mutates its maps.
  return loadTerrainMap(
    gameConfig.gameMap,
    gameConfig.gameMapSize,
    mapLoader,
    false,
    true,
  );
}

export async function playHeadless(
  spec: HeadlessGameSpec,
): Promise<GameResult> {
  const wall0 = performance.now();
  const { game, fly, step } = await createHeadlessGame(spec);

  let peak = 0;
  const flyPlayer = (): Player | null => fly.flyPlayer();
  while (game.ticks() < spec.maxTicks) {
    step();
    const me = flyPlayer();
    if (me !== null && !game.inSpawnPhase()) {
      const share = me.numTilesOwned() / Math.max(1, game.totalLandTiles());
      if (share > peak) peak = share;
      if (me.hasSpawned() && !me.isAlive()) break;
    }
    if (game.getWinner() !== null) break;
  }

  const me = flyPlayer();
  const alive = me !== null && me.isAlive();
  const ranked = game
    .players()
    .filter((p) => p.isAlive())
    .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
  const rank =
    me !== null && alive ? ranked.indexOf(me) + 1 : ranked.length + 1;
  const winner = game.getWinner();
  const winnerName =
    winner === null
      ? null
      : typeof winner === "string"
        ? winner
        : winner.name();
  return {
    seed: spec.seed,
    map: spec.map,
    ticks: game.ticks(),
    alive,
    landShare:
      me === null ? 0 : me.numTilesOwned() / Math.max(1, game.totalLandTiles()),
    peakLandShare: peak,
    rank,
    players: ranked.length + (alive ? 0 : 1),
    won: winner !== null && typeof winner !== "string" && winner === me,
    winner: winnerName,
    decisions: fly.decisions,
    actionCounts: fly.actionCounts,
    brainMs: fly.computeMsTotal,
    wallMs: performance.now() - wall0,
  };
}
