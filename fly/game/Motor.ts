import { AllianceRequestExecution } from "../../openfront/src/core/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "../../openfront/src/core/execution/AttackExecution";
import { ConstructionExecution } from "../../openfront/src/core/execution/ConstructionExecution";
import { randTerritoryTileArray } from "../../openfront/src/core/execution/nation/NationUtils";
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
import { Situation } from "./Senses";

// Motor programs. The brain picks one of these; the program works out the
// details (which tile, how many troops), the way a descending command such as
// "walk forward" is turned into leg movements by circuits in the ventral
// nerve cord.

export enum Action {
  Wait = 0,
  Expand = 1,
  Attack = 2,
  Retaliate = 3,
  Boat = 4,
  City = 5,
  Port = 6,
  Defend = 7,
  Ally = 8,
  Factory = 9,
}

export const ACTIONS: {
  action: Action;
  key: string;
  label: string;
  bio: string;
}[] = [
  {
    action: Action.Wait,
    key: "wait",
    label: "Wait",
    bio: "rest, let troops grow",
  },
  {
    action: Action.Expand,
    key: "expand",
    label: "Expand",
    bio: "feed on free land",
  },
  {
    action: Action.Attack,
    key: "attack",
    label: "Attack",
    bio: "pursue weak prey",
  },
  {
    action: Action.Retaliate,
    key: "retaliate",
    label: "Counter",
    bio: "fight back",
  },
  {
    action: Action.Boat,
    key: "boat",
    label: "Boat",
    bio: "take off over water",
  },
  { action: Action.City, key: "city", label: "City", bio: "grow the body" },
  { action: Action.Port, key: "port", label: "Port", bio: "forage by sea" },
  {
    action: Action.Defend,
    key: "defend",
    label: "Defend",
    bio: "brace for impact",
  },
  {
    action: Action.Ally,
    key: "ally",
    label: "Ally",
    bio: "answer a courtship song",
  },
  {
    action: Action.Factory,
    key: "factory",
    label: "Factory",
    bio: "store energy",
  },
];
export const N_ACTIONS = ACTIONS.length;

const NBUF8: TileRef[] = [0, 0, 0, 0, 0, 0, 0, 0];

export class Motor {
  constructor(
    private game: Game,
    private me: Player,
    private random: PseudoRandom,
  ) {}

  /** Which motor programs could run right now (the body's constraints). */
  feasible(s: Situation, out = new Uint8Array(N_ACTIONS)): Uint8Array {
    const t = s.troops;
    out.fill(0);
    out[Action.Wait] = 1;
    out[Action.Expand] = s.freeBorder > 0 && t > 100 ? 1 : 0;
    out[Action.Attack] =
      t > 100 && s.enemies.some((e) => this.me.canAttackPlayer(e)) ? 1 : 0;
    out[Action.Retaliate] =
      s.mainAttacker !== null &&
      t > 100 &&
      this.me.canAttackPlayer(s.mainAttacker)
        ? 1
        : 0;
    out[Action.Boat] =
      s.boatsAvailable && s.shoreTiles.length > 0 && t > 1000 ? 1 : 0;
    out[Action.City] = s.gold >= s.cityCost ? 1 : 0;
    out[Action.Port] = s.gold >= s.portCost && s.shoreTiles.length > 0 ? 1 : 0;
    out[Action.Defend] =
      s.gold >= s.defenseCost &&
      (s.mainAttacker !== null || s.strongest !== null)
        ? 1
        : 0;
    out[Action.Ally] =
      !this.game.config().disableAlliances() &&
      (s.allianceRequests.length > 0 ||
        (s.strongest !== null && this.me.canSendAllianceRequest(s.strongest)))
        ? 1
        : 0;
    const factoryCost = this.game.config().isUnitDisabled(UnitType.Factory)
      ? Number.POSITIVE_INFINITY
      : Number(
          this.game
            .config()
            .unitInfo(UnitType.Factory)
            .cost(this.game, this.me),
        );
    out[Action.Factory] = s.gold >= factoryCost && s.cities >= 2 ? 1 : 0;
    return out;
  }

  /** Runs the program; returns false if it found nothing to do. */
  execute(a: Action, s: Situation): boolean {
    switch (a) {
      case Action.Wait:
        return true;
      case Action.Expand:
        return this.expand(s);
      case Action.Attack:
        return this.attack(s);
      case Action.Retaliate:
        return this.retaliate(s);
      case Action.Boat:
        return this.boat(s);
      case Action.City:
        return this.build(UnitType.City, this.interiorTile(24));
      case Action.Port:
        return this.buildPort(s);
      case Action.Defend:
        return this.defend(s);
      case Action.Ally:
        return this.ally(s);
      case Action.Factory:
        return this.build(UnitType.Factory, this.interiorTile(24));
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
    const candidates = s.enemies.filter((e) => this.me.canAttackPlayer(e));
    if (candidates.length === 0) return false;
    // Bot tribes first (they are weak and hold captured structures), then the
    // weakest player.
    const bots = candidates.filter((e) => e.type() === PlayerType.Bot);
    const target = bots.length > 0 ? bots[0] : candidates[0];
    let troops: number;
    if (target.type() === PlayerType.Bot) {
      troops = Math.min(
        Math.max(4 * target.troops(), 0.15 * s.troops),
        Math.max(0.25 * s.troops, this.reserveAbove(s, 0.25)),
      );
    } else {
      troops = Math.max(0.3 * s.troops, this.reserveAbove(s, 0.3));
    }
    if (troops < 1) return false;
    return this.sendAt(target, troops);
  }

  private retaliate(s: Situation): boolean {
    const att = s.mainAttacker;
    if (att === null) return false;
    const troops = Math.min(
      0.8 * s.troops,
      Math.max(0.5 * s.troops, s.incomingTroops),
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
      for (let i = 0; i < 120; i++) {
        const r = 20 + 130 * this.random.next();
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
          if (owner.troops() > 0.6 * s.troops) continue;
          score =
            owner.type() === PlayerType.Bot
              ? 1.5
              : 1 - owner.troops() / s.troops;
        }
        score -= r / 300;
        if (score > bestScore) {
          bestScore = score;
          best = tile;
        }
      }
      if (best !== null && canBuildTransportShip(g, this.me, best)) {
        const troops = Math.max(0.2 * s.troops, this.reserveAbove(s, 0.35));
        g.addExecution(new TransportShipExecution(this.me, best, troops));
        return true;
      }
    }
    return false;
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

  private ally(s: Situation): boolean {
    let did = false;
    for (const req of s.allianceRequests) {
      const other = req.requestor();
      // Accept anyone who is not so weak that we would rather eat them.
      if (other.troops() > 0.4 * s.troops) {
        this.game.addExecution(
          new AllianceRequestExecution(this.me, other.id()),
        );
        did = true;
      }
    }
    if (
      !did &&
      s.strongest !== null &&
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
