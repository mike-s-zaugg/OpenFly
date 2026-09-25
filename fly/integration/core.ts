import { NationExecution } from "../../openfront/src/core/execution/NationExecution";
import {
  Execution,
  Game,
  PlayerType,
} from "../../openfront/src/core/game/Game";
import { GameConfig } from "../../openfront/src/core/Schemas";
import { FlyExecution } from "../game/FlyExecution";
import { FlyRegistry } from "../game/FlyRegistry";

// Hooks called from OpenFront's GameRunner.init() (see patches/). They decide
// which players get a fly brain for the configured OpenFly mode.

export type OpenflyConfig = NonNullable<GameConfig["openfly"]>;

export function openflyConfig(game: Game): OpenflyConfig | undefined {
  return game.config().gameConfig().openfly;
}

/**
 * Nation executions for the game. In "versus" mode up to `maxFlies` nations
 * get a fly brain instead of the built-in AI.
 */
export function openflyNationExecutions(
  game: Game,
  gameID: string,
  defaults: () => Execution[],
): Execution[] {
  const cfg = openflyConfig(game);
  if (cfg?.mode !== "versus" || !FlyRegistry.hasConnectome()) return defaults();
  const max = cfg.maxFlies ?? 4;
  return game.nations().map((nation, i) =>
    i < max
      ? new FlyExecution(nation.playerInfo, gameID, {
          policy: cfg.policy ?? "brain",
          telemetry: i === 0,
          // Land at once: in singleplayer the spawn phase ends as soon as
          // the human picks a spot.
          spawnDelayTicks: 0,
        })
      : new NationExecution(gameID, nation),
  );
}

/**
 * In "spectate" mode the fly possesses the local human's player: the HUD,
 * the camera and the leaderboard all follow it while the human watches.
 */
export function openflyExtraExecutions(
  game: Game,
  gameID: string,
): Execution[] {
  const cfg = openflyConfig(game);
  if (cfg?.mode !== "spectate" || !FlyRegistry.hasConnectome()) return [];
  const human = game.allPlayers().find((p) => p.type() === PlayerType.Human);
  if (human === undefined) return [];
  return [
    new FlyExecution(human.info(), gameID, {
      policy: cfg.policy ?? "brain",
      telemetry: true,
    }),
  ];
}
