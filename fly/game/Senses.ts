import {
  AllianceRequest,
  Game,
  Player,
  PlayerType,
  UnitType,
} from "../../openfront/src/core/game/Game";
import { TileRef } from "../../openfront/src/core/game/GameMap";

// What the fly perceives of the game at one decision point. Everything the
// brain is told comes from here, as 13 values in [0, 1] (SENSE_KEYS order,
// which matches the sensory channels in the brain file). The motor programs
// reuse the same survey to carry out the chosen action.

export const SENSE_KEYS = [
  "sugar",
  "touch",
  "looming",
  "pursuit",
  "prey",
  "rival",
  "wind",
  "song",
  "light",
  "energy",
  "wealth",
  "size",
  "strain",
] as const;
export type SenseKey = (typeof SENSE_KEYS)[number];

export interface Situation {
  tick: number;
  elapsedSec: number;
  troops: number;
  maxTroops: number;
  troopRatio: number;
  gold: number;
  cityCost: number;
  portCost: number;
  defenseCost: number;
  tilesOwned: number;
  landShare: number;
  borderTiles: number;
  /** Border tiles touching unclaimed, unnuked land. */
  freeBorder: number;
  /** Bordering, non-friendly players sorted by troops ascending. */
  enemies: Player[];
  /** Bordering bot tribes (subset of enemies). */
  bots: Player[];
  weakest: Player | null;
  strongest: Player | null;
  incomingTroops: number;
  mainAttacker: Player | null;
  outgoingTroops: number;
  shoreTiles: TileRef[];
  boatsAvailable: boolean;
  boatsOut: number;
  allianceRequests: AllianceRequest[];
  cities: number;
  ports: number;
  defensePosts: number;
}

const NBUF: TileRef[] = [0, 0, 0, 0];

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function survey(game: Game, me: Player): Situation {
  const config = game.config();
  const troops = me.troops();
  const maxTroops = config.maxTroops(me);
  const mySmall = me.smallID();

  let freeBorder = 0;
  const neighborSet = new Set<Player>();
  const shoreTiles: TileRef[] = [];
  me.borderTiles().forEach((t) => {
    if (game.isShore(t)) shoreTiles.push(t);
    let touchesFree = false;
    const n = game.neighbors4(t, NBUF);
    for (let k = 0; k < n; k++) {
      const nb = NBUF[k];
      if (!game.isLand(nb) || game.isImpassable(nb)) continue;
      const owner = game.ownerID(nb);
      if (owner === mySmall) continue;
      if (owner === 0) {
        if (!game.hasFallout(nb)) touchesFree = true;
      } else {
        const p = game.playerBySmallID(owner);
        if (p.isPlayer()) neighborSet.add(p);
      }
    }
    if (touchesFree) freeBorder++;
  });
  for (const n of me.nearby()) {
    if (n.isPlayer()) neighborSet.add(n);
  }

  const enemies = [...neighborSet]
    .filter((p) => p.isAlive() && !me.isFriendly(p))
    .sort((a, b) => a.troops() - b.troops());
  const bots = enemies.filter((p) => p.type() === PlayerType.Bot);
  const nonBots = enemies.filter((p) => p.type() !== PlayerType.Bot);

  let incomingTroops = 0;
  let mainAttacker: Player | null = null;
  let biggest = 0;
  for (const a of me.incomingAttacks()) {
    const att = a.attacker();
    if (me.isFriendly(att)) continue;
    incomingTroops += a.troops();
    if (a.troops() > biggest) {
      biggest = a.troops();
      mainAttacker = att;
    }
  }
  let outgoingTroops = 0;
  for (const a of me.outgoingAttacks()) outgoingTroops += a.troops();

  const cost = (t: UnitType) =>
    config.isUnitDisabled(t)
      ? Number.POSITIVE_INFINITY
      : Number(config.unitInfo(t).cost(game, me));

  return {
    tick: game.ticks(),
    elapsedSec: game.inSpawnPhase() ? 0 : game.elapsedGameSeconds(),
    troops,
    maxTroops,
    troopRatio: maxTroops > 0 ? troops / maxTroops : 0,
    gold: Number(me.gold()),
    cityCost: cost(UnitType.City),
    portCost: cost(UnitType.Port),
    defenseCost: cost(UnitType.DefensePost),
    tilesOwned: me.numTilesOwned(),
    landShare: me.numTilesOwned() / Math.max(1, game.totalLandTiles()),
    borderTiles: me.borderTiles().size,
    freeBorder,
    enemies,
    bots,
    weakest: nonBots[0] ?? null,
    strongest: nonBots[nonBots.length - 1] ?? null,
    incomingTroops,
    mainAttacker,
    outgoingTroops,
    shoreTiles,
    boatsAvailable:
      !config.isUnitDisabled(UnitType.TransportShip) &&
      me.unitCount(UnitType.TransportShip) < config.boatMaxNumber(),
    boatsOut: me.unitCount(UnitType.TransportShip),
    allianceRequests: me
      .incomingAllianceRequests()
      .filter((r) => r.status() === "pending"),
    cities: me.unitCount(UnitType.City),
    ports: me.unitCount(UnitType.Port),
    defensePosts: me.unitCount(UnitType.DefensePost),
  };
}

/** The 13 sensory values, each in [0, 1]. */
export function senses(s: Situation, out = new Float32Array(13)): Float32Array {
  const t = Math.max(1, s.troops);
  const threat = s.incomingTroops / t;
  out[0] = clamp01((3 * s.freeBorder) / Math.max(1, s.borderTiles));
  out[1] = clamp01(Math.sqrt(threat));
  out[2] = clamp01((threat - 0.4) / 0.8);
  out[3] = s.weakest ? clamp01(1.4 - s.weakest.troops() / t) : 0;
  out[4] =
    s.bots.length > 0
      ? clamp01(0.4 + 0.3 * s.bots.length - s.bots[0].troops() / t)
      : 0;
  out[5] = s.strongest ? clamp01(s.strongest.troops() / t / 3) : 0;
  out[6] =
    s.shoreTiles.length > 0 && s.boatsAvailable
      ? s.freeBorder === 0 && s.enemies.length === 0
        ? 1
        : 0.35
      : 0;
  out[7] = clamp01(s.allianceRequests.length / 2);
  out[8] = clamp01(s.elapsedSec / 1500);
  out[9] = clamp01(s.troopRatio);
  out[10] = Number.isFinite(s.cityCost) ? clamp01(s.gold / (2 * s.cityCost)) : 0;
  out[11] = clamp01(Math.sqrt(s.landShare * 4));
  out[12] = clamp01(s.outgoingTroops / (s.outgoingTroops + t));
  return out;
}
