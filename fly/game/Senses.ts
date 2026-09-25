import {
  AllianceRequest,
  Game,
  Player,
  PlayerType,
  UnitType,
} from "../../openfront/src/core/game/Game";
import { TileRef } from "../../openfront/src/core/game/GameMap";

// What the fly perceives of the game at one decision point. Everything the
// brain is told comes from here, as values in [0, 1] (SENSE_KEYS order, which
// matches the sensory channels in the brain file). The motor programs reuse
// the same survey to carry out the chosen actions.

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
  "hoard",
  "shore",
  "build",
  "sky",
] as const;
export const N_SENSES = SENSE_KEYS.length;
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
  /** Who the Attack program would go for (see attackTarget). */
  target: Player | null;
  /** Troops the Attack program would send at the target (0: none). */
  stack: number;
  incomingTroops: number;
  mainAttacker: Player | null;
  /**
   * Troops the main attacker has coming at us minus what we already have
   * going at it. Countering only while this is positive keeps the fly from
   * emptying itself into one fight.
   */
  counterGap: number;
  outgoingTroops: number;
  shoreTiles: TileRef[];
  boatsAvailable: boolean;
  boatsOut: number;
  allianceRequests: AllianceRequest[];
  cities: number;
  ports: number;
  factories: number;
  defensePosts: number;
  sams: number;
  silos: number;
  /** Silos that are built and not reloading. */
  readySilos: number;
  /** A non-friendly player who could nuke us owns a silo. */
  rivalSilos: number;
  /** Nukes in the air aimed at our territory. */
  incomingNukes: number;
}

/**
 * The bordering enemy the Attack program would go for: bot tribes first
 * (weak, and they hold captured structures), otherwise the player we
 * outnumber the most, with a bonus for one already being eaten by others.
 */
export function attackTarget(
  me: Player,
  enemies: Player[],
  troops: number,
): Player | null {
  const candidates = enemies.filter((e) => me.canAttackPlayer(e));
  if (candidates.length === 0) return null;
  const t = Math.max(1, troops);
  const bots = candidates.filter(
    (e) => e.type() === PlayerType.Bot && e.troops() < 0.5 * t,
  );
  if (bots.length > 0) {
    return bots.reduce((a, b) =>
      a.troops() / Math.max(1, a.numTilesOwned()) <=
      b.troops() / Math.max(1, b.numTilesOwned())
        ? a
        : b,
    );
  }
  let best: Player | null = null;
  let bestScore = Infinity;
  for (const e of candidates) {
    const underAttack = e
      .incomingAttacks()
      .some((a) => a.attacker() !== me && a.troops() > 0.2 * e.troops());
    const score = e.troops() * (underAttack ? 0.7 : 1);
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/**
 * Share of the strongest bordering nation's army that attacks must leave at
 * home. OpenFront's nations pick on the weakest player next to them, and its
 * Hard nations keep 75% of their strongest neighbour's troops for the same
 * reason.
 */
export const HOME_GUARD = 0.75;

/** Most troops an attack or boat may take without breaking the home guard. */
export function sendCap(s: {
  troops: number;
  strongest: Player | null;
}): number {
  const rival = s.strongest !== null ? s.strongest.troops() : 0;
  return rival > 0 ? Math.max(0, s.troops - HOME_GUARD * rival) : s.troops;
}

/**
 * Troops the Attack program sends at a player: everything above a reserve of
 * 30% of the troop cap, at least 30% and at most 85% of what we have, and
 * never so many that the home guard breaks. Big stacks pay less per tile
 * (OpenFront scales attacker losses with how outnumbered the stack is) and
 * troops regrow fastest near half the cap.
 */
export function attackStack(s: {
  troops: number;
  maxTroops: number;
  strongest: Player | null;
}): number {
  return Math.min(
    0.85 * s.troops,
    Math.max(0.3 * s.troops, s.troops - 0.3 * s.maxTroops),
    sendCap(s),
  );
}

/**
 * Troops the Attack program sends at a bot tribe: four times its army, but at
 * least 15% and at most the surplus above a quarter of the cap. Bot attacks
 * are small and quick, so the home guard does not apply to them (guarding
 * them too cost 10 points of land share in the tuning games). 0 when that
 * leaves less than twice the tribe's army (OpenFront's nations use the same
 * cut-off).
 */
export function botStack(
  s: { troops: number; maxTroops: number; strongest: Player | null },
  bot: Player,
): number {
  const want = Math.min(
    Math.max(4 * bot.troops(), 0.15 * s.troops),
    Math.max(0.25 * s.troops, s.troops - 0.25 * s.maxTroops),
  );
  return want < 2 * bot.troops() ? 0 : want;
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
  let counterGap = 0;
  for (const a of me.incomingAttacks()) {
    if (a.attacker() === mainAttacker) counterGap += a.troops();
  }
  for (const a of me.outgoingAttacks()) {
    outgoingTroops += a.troops();
    if (mainAttacker !== null && a.target() === mainAttacker) {
      counterGap -= a.troops();
    }
  }

  let rivalSilos = 0;
  for (const p of game.players()) {
    if (p === me || me.isFriendly(p) || p.type() === PlayerType.Bot) continue;
    if (p.unitCount(UnitType.MissileSilo) > 0) rivalSilos++;
  }
  let incomingNukes = 0;
  for (const u of game.units(
    UnitType.AtomBomb,
    UnitType.HydrogenBomb,
    UnitType.MIRVWarhead,
  )) {
    if (u.owner() === me) continue;
    const t = u.targetTile();
    if (t !== undefined && game.owner(t) === me) incomingNukes++;
  }
  const silos = me.units(UnitType.MissileSilo);
  const readySilos = silos.filter(
    (u) => !u.isUnderConstruction() && !u.isInCooldown(),
  ).length;

  const cost = (t: UnitType) =>
    config.isUnitDisabled(t)
      ? Number.POSITIVE_INFINITY
      : Number(config.unitInfo(t).cost(game, me));

  const strongest = nonBots[nonBots.length - 1] ?? null;
  const target = attackTarget(me, enemies, troops);
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
    strongest,
    target,
    stack:
      target === null
        ? 0
        : target.type() === PlayerType.Bot
          ? botStack({ troops, maxTroops, strongest }, target)
          : attackStack({ troops, maxTroops, strongest }),
    incomingTroops,
    mainAttacker,
    counterGap,
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
    factories: me.unitCount(UnitType.Factory),
    defensePosts: me.unitCount(UnitType.DefensePost),
    sams: me.unitCount(UnitType.SAMLauncher),
    silos: silos.length,
    readySilos,
    rivalSilos,
    incomingNukes,
  };
}

/** Ports a coastal empire of this size should have. */
export function wantedPorts(s: Situation): number {
  return s.shoreTiles.length === 0 ? 0 : Math.max(1, Math.ceil(s.cities / 2));
}

/** Factories an empire of this size should have. */
export function wantedFactories(s: Situation): number {
  return s.cities < 3 ? 0 : Math.ceil(0.4 * s.cities);
}

/** The sensory values, each in [0, 1], in SENSE_KEYS order. */
export function senses(
  s: Situation,
  out = new Float32Array(N_SENSES),
): Float32Array {
  const t = Math.max(1, s.troops);
  const threat = s.incomingTroops / t;
  out[0] = clamp01((3 * s.freeBorder) / Math.max(1, s.borderTiles));
  out[1] = clamp01(Math.sqrt(threat));
  out[2] = clamp01((threat - 0.4) / 0.8);
  // Stack we would send vs the target's army, log scale: 1/4 -> 0, even ->
  // 0.5, 4x -> 1. This is what the attack decision hinges on.
  out[3] =
    s.target !== null
      ? clamp01(0.5 + Math.log2(s.stack / Math.max(1, s.target.troops())) / 4)
      : 0;
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
  out[10] = Number.isFinite(s.cityCost)
    ? clamp01(s.gold / (2 * s.cityCost))
    : 0;
  out[11] = clamp01(Math.sqrt(s.landShare * 4));
  out[12] = clamp01(s.outgoingTroops / (s.outgoingTroops + t));
  out[13] = clamp01(Math.log10(Math.max(1, s.gold) / 1e5) / 3);
  out[14] = clamp01((wantedPorts(s) - s.ports) / 2);
  out[15] = clamp01((wantedFactories(s) - s.factories) / 2);
  out[16] = clamp01(
    0.3 * Math.min(1, s.rivalSilos) + 0.7 * Math.min(1, s.incomingNukes),
  );
  return out;
}
