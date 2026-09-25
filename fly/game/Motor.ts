import { AllianceRequestExecution } from "../../openfront/src/core/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "../../openfront/src/core/execution/AttackExecution";
import { ConstructionExecution } from "../../openfront/src/core/execution/ConstructionExecution";
import { randTerritoryTileArray } from "../../openfront/src/core/execution/nation/NationUtils";
import { NukeExecution } from "../../openfront/src/core/execution/NukeExecution";
import { TransportShipExecution } from "../../openfront/src/core/execution/TransportShipExecution";
import { closestTwoTiles } from "../../openfront/src/core/execution/Util";
import {
  Game,
  Player,
  PlayerType,
  Structures,
  UnitType,
} from "../../openfront/src/core/game/Game";
import { TileRef } from "../../openfront/src/core/game/GameMap";
import { canBuildTransportShip } from "../../openfront/src/core/game/TransportShipUtils";
import { PseudoRandom } from "../../openfront/src/core/PseudoRandom";
import { sendCap, Situation } from "./Senses";

export { attackStack, botStack } from "./Senses";

// Motor programs. The brain drives two heads in parallel, one for fighting
// and one for the economy and diplomacy, and each decision picks one program
// per head. A program works out the details (which tile, how many troops),
// the way a descending command such as "walk forward" is turned into leg
// movements by circuits in the ventral nerve cord.

export enum Mil {
  Wait = 0,
  Expand = 1,
  Attack = 2,
  Retaliate = 3,
  Boat = 4,
  Nuke = 5,
}

export enum Eco {
  Save = 0,
  City = 1,
  Port = 2,
  Factory = 3,
  Defend = 4,
  Sam = 5,
  Silo = 6,
  Ally = 7,
}

export interface ProgramInfo {
  key: string;
  label: string;
  bio: string;
}

export const MILITARY: ProgramInfo[] = [
  { key: "wait", label: "Wait", bio: "rest, let troops grow" },
  { key: "expand", label: "Expand", bio: "feed on free land" },
  { key: "attack", label: "Attack", bio: "pursue weak prey" },
  { key: "retaliate", label: "Counter", bio: "fight back" },
  { key: "boat", label: "Boat", bio: "take off over water" },
  { key: "nuke", label: "Nuke", bio: "sting" },
];

export const ECONOMY: ProgramInfo[] = [
  { key: "save", label: "Save", bio: "keep the gold" },
  { key: "city", label: "City", bio: "grow the body" },
  { key: "port", label: "Port", bio: "forage by sea" },
  { key: "factory", label: "Factory", bio: "store energy" },
  { key: "defend", label: "Defense post", bio: "brace for impact" },
  { key: "sam", label: "SAM", bio: "swat from the sky" },
  { key: "silo", label: "Missile silo", bio: "grow a stinger" },
  { key: "ally", label: "Ally", bio: "answer a courtship song" },
];

export interface HeadInfo {
  key: "military" | "economy";
  label: string;
  programs: ProgramInfo[];
}

export const HEADS: HeadInfo[] = [
  { key: "military", label: "Military", programs: MILITARY },
  { key: "economy", label: "Economy & diplomacy", programs: ECONOMY },
];
export const N_MIL = MILITARY.length;
export const N_ECO = ECONOMY.length;

const NBUF8: TileRef[] = [0, 0, 0, 0, 0, 0, 0, 0];

type NukeType = UnitType.AtomBomb | UnitType.HydrogenBomb;

/** Who a nuke would be aimed at: the main attacker, else the strongest rival. */
export function nukeTarget(s: Situation): Player | null {
  if (s.mainAttacker !== null && s.mainAttacker.type() !== PlayerType.Bot) {
    return s.mainAttacker;
  }
  return s.strongest;
}

export class Motor {
  constructor(
    private game: Game,
    private me: Player,
    private random: PseudoRandom,
  ) {}

  private cost(type: UnitType): number {
    const cfg = this.game.config();
    return cfg.isUnitDisabled(type)
      ? Number.POSITIVE_INFINITY
      : Number(cfg.unitInfo(type).cost(this.game, this.me));
  }

  /** Which military programs could run right now (the body's constraints). */
  feasibleMilitary(s: Situation, out = new Uint8Array(N_MIL)): Uint8Array {
    const t = s.troops;
    out.fill(0);
    out[Mil.Wait] = 1;
    out[Mil.Expand] = s.freeBorder > 0 && t > 100 ? 1 : 0;
    out[Mil.Attack] = t > 100 && s.target !== null && s.stack >= 1 ? 1 : 0;
    out[Mil.Retaliate] =
      s.mainAttacker !== null &&
      t > 100 &&
      s.counterGap > 0 &&
      this.me.canAttackPlayer(s.mainAttacker)
        ? 1
        : 0;
    out[Mil.Boat] =
      s.boatsAvailable && s.shoreTiles.length > 0 && t > 1000 ? 1 : 0;
    const target = nukeTarget(s);
    out[Mil.Nuke] =
      s.readySilos > 0 &&
      target !== null &&
      s.gold >= this.cost(UnitType.AtomBomb)
        ? 1
        : 0;
    return out;
  }

  /** Which economy/diplomacy programs could run right now. */
  feasibleEconomy(s: Situation, out = new Uint8Array(N_ECO)): Uint8Array {
    out.fill(0);
    out[Eco.Save] = 1;
    out[Eco.City] = s.gold >= s.cityCost ? 1 : 0;
    out[Eco.Port] = s.gold >= s.portCost && s.shoreTiles.length > 0 ? 1 : 0;
    out[Eco.Factory] =
      s.cities >= 2 && s.gold >= this.cost(UnitType.Factory) ? 1 : 0;
    out[Eco.Defend] =
      s.gold >= s.defenseCost &&
      (s.mainAttacker !== null || s.strongest !== null)
        ? 1
        : 0;
    out[Eco.Sam] =
      s.cities >= 1 && s.gold >= this.cost(UnitType.SAMLauncher) ? 1 : 0;
    out[Eco.Silo] = s.gold >= this.cost(UnitType.MissileSilo) ? 1 : 0;
    out[Eco.Ally] =
      !this.game.config().disableAlliances() &&
      (s.allianceRequests.length > 0 ||
        (s.strongest !== null && this.me.canSendAllianceRequest(s.strongest)))
        ? 1
        : 0;
    return out;
  }

  /** Runs a military program; returns false if it found nothing to do. */
  military(a: Mil, s: Situation): boolean {
    switch (a) {
      case Mil.Wait:
        return true;
      case Mil.Expand:
        return this.expand(s);
      case Mil.Attack:
        return this.attack(s);
      case Mil.Retaliate:
        return this.retaliate(s);
      case Mil.Boat:
        return this.boat(s);
      case Mil.Nuke:
        return this.nuke(s);
    }
  }

  /** Runs an economy program; returns false if it found nothing to do. */
  economy(a: Eco, s: Situation): boolean {
    switch (a) {
      case Eco.Save:
        return true;
      case Eco.City:
        return this.build(UnitType.City, this.interiorTile(24));
      case Eco.Port:
        return this.buildPort(s);
      case Eco.Factory:
        return this.build(UnitType.Factory, this.nearCity(30));
      case Eco.Defend:
        return this.defend(s);
      case Eco.Sam:
        return this.build(UnitType.SAMLauncher, this.nearCity(12));
      case Eco.Silo:
        return this.build(UnitType.MissileSilo, this.interiorTile(24));
      case Eco.Ally:
        return this.ally(s);
    }
  }

  private reserveAbove(s: Situation, keepRatio: number): number {
    return s.troops - keepRatio * s.maxTroops;
  }

  private expand(s: Situation): boolean {
    const troops = Math.max(0.2 * s.troops, this.reserveAbove(s, 0.3));
    if (troops < 1) return false;
    this.game.addExecution(
      new AttackExecution(troops, this.me, this.game.terraNullius().id()),
    );
    return true;
  }

  private attack(s: Situation): boolean {
    if (s.target === null || s.stack < 1) return false;
    return this.sendAt(s.target, s.stack);
  }

  /** Counter-attack with what we can spare above a 35% reserve. */
  private retaliate(s: Situation): boolean {
    const att = s.mainAttacker;
    if (att === null) return false;
    const troops = Math.min(
      0.7 * s.troops,
      Math.max(0.2 * s.troops, this.reserveAbove(s, 0.35)),
    );
    return this.sendAt(att, troops);
  }

  private sendAt(target: Player, troops: number): boolean {
    if (this.me.sharesBorderWith(target)) {
      this.game.addExecution(new AttackExecution(troops, this.me, target.id()));
      return true;
    }
    if (!this.game.config().isUnitDisabled(UnitType.TransportShip)) {
      const shore = this.shoreOf(target);
      const mine = this.shoreOf(this.me);
      const pair = closestTwoTiles(this.game, mine, shore);
      if (pair !== null && canBuildTransportShip(this.game, this.me, pair.y)) {
        this.game.addExecution(
          new TransportShipExecution(this.me, pair.y, troops / 2),
        );
        return true;
      }
    }
    return false;
  }

  private shoreOf(p: Player): TileRef[] {
    const out: TileRef[] = [];
    p.borderTiles().forEach((t) => {
      if (this.game.isShore(t)) out.push(t);
    });
    return out;
  }

  /** Boat to the nearest reachable land that is free or weaker than us. */
  private boat(s: Situation): boolean {
    if (s.shoreTiles.length === 0) return false;
    const g = this.game;
    for (let attempt = 0; attempt < 3; attempt++) {
      const src = s.shoreTiles[this.random.nextInt(0, s.shoreTiles.length)];
      const x = g.x(src);
      const y = g.y(src);
      let best: TileRef | null = null;
      let bestScore = -Infinity;
      for (let i = 0; i < 160; i++) {
        const r = 20 + 280 * this.random.next();
        const ang = this.random.next() * Math.PI * 2;
        const tx = Math.round(x + r * Math.cos(ang));
        const ty = Math.round(y + r * Math.sin(ang));
        if (!g.isValidCoord(tx, ty)) continue;
        const tile = g.ref(tx, ty);
        if (!g.isLand(tile) || g.isImpassable(tile)) continue;
        const owner = g.owner(tile);
        if (owner === this.me) continue;
        let score: number;
        if (!owner.isPlayer()) {
          if (g.hasFallout(tile)) continue;
          score = 2;
        } else {
          if (this.me.isFriendly(owner)) continue;
          if (owner.troops() > 0.8 * s.troops) continue;
          score =
            owner.type() === PlayerType.Bot
              ? 1.5
              : 1 - owner.troops() / s.troops;
        }
        score -= r / 500;
        if (score > bestScore) {
          bestScore = score;
          best = tile;
        }
      }
      if (best !== null && canBuildTransportShip(g, this.me, best)) {
        const troops = Math.min(
          Math.max(0.25 * s.troops, this.reserveAbove(s, 0.35)),
          sendCap(s),
        );
        if (troops < 1) return false;
        g.addExecution(new TransportShipExecution(this.me, best, troops));
        return true;
      }
    }
    return false;
  }

  /**
   * Nuke the target's most valuable spot that is safe for us and our allies:
   * a hydrogen bomb when we can afford one, an atom bomb otherwise.
   */
  private nuke(s: Situation): boolean {
    const target = nukeTarget(s);
    if (target === null) return false;
    const g = this.game;
    const cfg = g.config();
    const hydro = this.cost(UnitType.HydrogenBomb);
    const type: NukeType =
      s.gold >= hydro ? UnitType.HydrogenBomb : UnitType.AtomBomb;
    if (s.gold < this.cost(type)) return false;
    const outer = cfg.nukeMagnitudes(type).outer;
    const structures = target.units(Structures.types);
    const candidates = new Set<TileRef>([
      ...structures.map((u) => u.tile()),
      ...randTerritoryTileArray(this.random, g, target, 12),
    ]);
    let best: TileRef | null = null;
    let bestScore = -Infinity;
    for (const tile of candidates) {
      if (!this.blastIsSafe(tile, outer)) continue;
      let score = this.random.next();
      const r2 = outer * outer;
      for (const u of structures) {
        if (g.euclideanDistSquared(tile, u.tile()) > r2) continue;
        const level = u.level();
        switch (u.type()) {
          case UnitType.City:
            score += 25 * level;
            break;
          case UnitType.MissileSilo:
            score += 50 * level;
            break;
          case UnitType.SAMLauncher:
            score -= 40;
            break;
          default:
            score += 10 * level;
        }
      }
      if (score <= bestScore) continue;
      if (this.me.canBuild(type, tile) === false) continue;
      bestScore = score;
      best = tile;
    }
    if (best === null) return false;
    g.addExecution(new NukeExecution(type, this.me, best, null));
    return true;
  }

  /** No tile of ours or of a friend inside the blast (sampled). */
  private blastIsSafe(center: TileRef, radius: number): boolean {
    const g = this.game;
    const cx = g.x(center);
    const cy = g.y(center);
    for (const r of [0, radius * 0.5, radius]) {
      const n = r === 0 ? 1 : 16;
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const x = Math.round(cx + r * Math.cos(ang));
        const y = Math.round(cy + r * Math.sin(ang));
        if (!g.isValidCoord(x, y)) continue;
        const owner = g.owner(g.ref(x, y));
        if (!owner.isPlayer()) continue;
        if (owner === this.me || this.me.isFriendly(owner)) return false;
      }
    }
    return true;
  }

  private build(type: UnitType, tile: TileRef | null): boolean {
    if (tile === null) return false;
    const spot = this.me.canBuild(type, tile);
    if (spot === false) return false;
    this.game.addExecution(new ConstructionExecution(this.me, type, spot));
    return true;
  }

  /** A random owned tile, preferring ones far from borders and other structures. */
  private interiorTile(samples: number): TileRef | null {
    const g = this.game;
    if (this.me.numTilesOwned() === 0) return null;
    const border: TileRef[] = [];
    let k = 0;
    const step = Math.max(1, Math.floor(this.me.borderTiles().size / 64));
    this.me.borderTiles().forEach((t) => {
      if (k++ % step === 0) border.push(t);
    });
    let best: TileRef | null = null;
    let bestScore = -Infinity;
    for (const t of randTerritoryTileArray(this.random, g, this.me, samples)) {
      let d = Infinity;
      for (const b of border) d = Math.min(d, g.manhattanDist(t, b));
      const crowded = g.anyUnitNearby(
        t,
        g.config().structureMinDist() * 2,
        Structures.types,
        () => true,
        this.me.id(),
      );
      const score = Math.min(d, 40) - (crowded ? 15 : 0) + this.random.next();
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  /** An owned tile within `radius` of one of our cities. */
  private nearCity(radius: number): TileRef | null {
    const g = this.game;
    const cities = this.me.units(UnitType.City);
    if (cities.length === 0) return this.interiorTile(12);
    for (let i = 0; i < 16; i++) {
      const c = cities[this.random.nextInt(0, cities.length)].tile();
      const x = g.x(c) + this.random.nextInt(-radius, radius + 1);
      const y = g.y(c) + this.random.nextInt(-radius, radius + 1);
      if (!g.isValidCoord(x, y)) continue;
      const t = g.ref(x, y);
      if (g.owner(t) === this.me && !g.isBorder(t)) return t;
    }
    return this.interiorTile(12);
  }

  private buildPort(s: Situation): boolean {
    for (let i = 0; i < 8 && s.shoreTiles.length > 0; i++) {
      const t = s.shoreTiles[this.random.nextInt(0, s.shoreTiles.length)];
      if (this.build(UnitType.Port, t)) return true;
    }
    return false;
  }

  /** Defense post just behind the border facing the main threat. */
  private defend(s: Situation): boolean {
    const foe = s.mainAttacker ?? s.strongest;
    if (foe === null) return false;
    const g = this.game;
    const front: TileRef[] = [];
    this.me.borderTiles().forEach((t) => {
      const n = g.neighbors8(t, NBUF8);
      for (let k = 0; k < n; k++) {
        if (g.owner(NBUF8[k]) === foe) {
          front.push(t);
          return;
        }
      }
    });
    if (front.length === 0) return false;
    for (let i = 0; i < 6; i++) {
      const t = front[this.random.nextInt(0, front.length)];
      if (
        g.hasUnitNearby(
          t,
          g.config().defensePostRange(),
          UnitType.DefensePost,
          this.me.id(),
        )
      ) {
        continue;
      }
      if (this.build(UnitType.DefensePost, t)) return true;
    }
    return false;
  }

  /**
   * Accept alliances from players about as strong as us or stronger (weaker
   * ones are better eaten), or court the strongest neighbour when it clearly
   * outclasses us.
   */
  private ally(s: Situation): boolean {
    let did = false;
    for (const req of s.allianceRequests) {
      const other = req.requestor();
      if (other.troops() > 0.7 * s.troops) {
        this.game.addExecution(
          new AllianceRequestExecution(this.me, other.id()),
        );
        did = true;
      }
    }
    if (
      !did &&
      s.strongest !== null &&
      s.strongest.troops() > 1.3 * s.troops &&
      this.me.canSendAllianceRequest(s.strongest)
    ) {
      this.game.addExecution(
        new AllianceRequestExecution(this.me, s.strongest.id()),
      );
      did = true;
    }
    return did;
  }
}
