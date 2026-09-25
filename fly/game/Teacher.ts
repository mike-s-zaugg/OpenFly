import { Player, PlayerType } from "../../openfront/src/core/game/Game";
import { PseudoRandom } from "../../openfront/src/core/PseudoRandom";
import { Eco, Mil, nukeTarget } from "./Motor";
import { Situation, wantedFactories, wantedPorts } from "./Senses";

// A hand-written policy used only to train the brain's readout: the fly
// watches these choices while its connectome processes the same senses, and
// the readout learns to produce them from descending-neuron activity alone.
//
// It has two independent parts, like the fly's two motor heads, so building
// never starves fighting: every decision picks one military program and one
// economy/diplomacy program.

export interface TeacherParams {
  expandAt: number;
  /**
   * Attack whenever our stack outnumbers the target by this factor and we
   * hold at least `crushAt` of our cap. Ratio rules alone fail when cities
   * keep raising the cap faster than troops grow.
   */
  crushAt: number;
  crushRatio: number;
  /** Attack once the stack we would send matches this share of the target. */
  attackAt: number;
  stackRatio: number;
  /** Above this troop ratio, spend the surplus even on a costlier fight. */
  surplusAt: number;
  surplusStackRatio: number;
  boatAt: number;
  /** Counter only attackers with fewer troops than this share of ours. */
  retaliateRatio: number;
  /** Gold (in atom bombs) we must hold before nuking a rival not attacking us. */
  richNukes: number;
}

export const DEFAULT_TEACHER: TeacherParams = {
  expandAt: 0.2,
  crushAt: 0.25,
  crushRatio: 1.0,
  attackAt: 0.4,
  stackRatio: 0.5,
  surplusAt: 0.6,
  surplusStackRatio: 0.25,
  boatAt: 0.5,
  retaliateRatio: 1.1,
  richNukes: 6,
};

export function teacherMilitary(
  s: Situation,
  mask: Uint8Array,
  me: Player,
  costs: { atom: number },
  p: TeacherParams = DEFAULT_TEACHER,
): Mil {
  const r = s.troopRatio;
  const t = Math.max(1, s.troops);
  const can = (a: Mil) => mask[a] === 1;

  // Fight back against a real attack we can match, from the surplus.
  if (
    can(Mil.Retaliate) &&
    s.mainAttacker !== null &&
    r > 0.4 &&
    s.incomingTroops > 0.1 * t &&
    s.mainAttacker.troops() < p.retaliateRatio * t
  ) {
    return Mil.Retaliate;
  }
  // Nukes: at whoever is attacking us hard, or, once rich, at a rival that
  // is catching up. Nuking early just makes enemies.
  const nt = nukeTarget(s);
  if (can(Mil.Nuke) && nt !== null) {
    const underFire = s.mainAttacker === nt && s.incomingTroops > 0.3 * t;
    const rich = s.gold >= p.richNukes * costs.atom;
    if (underFire || (rich && nt.troops() > 0.8 * t)) return Mil.Nuke;
  }
  if (can(Mil.Expand) && r > p.expandAt) return Mil.Expand;

  const target = can(Mil.Attack) ? s.target : null;
  if (target !== null) {
    if (target.type() === PlayerType.Bot) {
      if (r > 0.3) return Mil.Attack;
    } else {
      const stack = s.stack;
      const enemy = Math.max(1, target.troops());
      if (r > p.crushAt && stack >= p.crushRatio * enemy) return Mil.Attack;
      if (r > p.attackAt && stack >= p.stackRatio * enemy) return Mil.Attack;
      if (r > p.surplusAt && stack >= p.surplusStackRatio * enemy) {
        return Mil.Attack;
      }
    }
  }
  // Boats when there is nothing to take by land. One boat at a time.
  if (
    can(Mil.Boat) &&
    s.boatsOut === 0 &&
    s.freeBorder === 0 &&
    s.bots.length === 0 &&
    (s.enemies.length === 0 ? r > p.boatAt : r > 0.85)
  ) {
    return Mil.Boat;
  }
  return Mil.Wait;
}

export function teacherEconomy(
  s: Situation,
  mask: Uint8Array,
  random: PseudoRandom,
  costs: { atom: number },
  p: TeacherParams = DEFAULT_TEACHER,
): Eco {
  const can = (a: Eco) => mask[a] === 1;
  const t = Math.max(1, s.troops);
  const threat = s.incomingTroops / t;
  // Keep enough for a bomb once we own a silo and have someone to aim at.
  const reserve = s.silos > 0 && s.strongest !== null ? costs.atom : 0;
  const afford = (cost: number) => s.gold >= cost + reserve;

  if (can(Eco.Defend) && threat > 0.4 && s.defensePosts < 2 + s.cities / 2) {
    return Eco.Defend;
  }
  if (
    can(Eco.Sam) &&
    (s.incomingNukes > 0 || s.rivalSilos > 0) &&
    s.sams < 1 + Math.floor(s.cities / 5)
  ) {
    return Eco.Sam;
  }
  if (
    can(Eco.Ally) &&
    s.allianceRequests.some((r) => r.requestor().troops() > 0.7 * t)
  ) {
    return Eco.Ally;
  }
  if (can(Eco.Port) && s.ports < wantedPorts(s) && afford(s.portCost)) {
    return Eco.Port;
  }
  if (can(Eco.City) && afford(s.cityCost)) return Eco.City;
  if (can(Eco.Factory) && s.factories < wantedFactories(s)) {
    return Eco.Factory;
  }
  if (
    can(Eco.Silo) &&
    s.silos === 0 &&
    s.cities >= 8 &&
    s.strongest !== null &&
    s.gold >= p.richNukes * costs.atom
  ) {
    return Eco.Silo;
  }
  if (
    can(Eco.Ally) &&
    s.strongest !== null &&
    s.strongest.troops() > 1.5 * t &&
    random.chance(8)
  ) {
    return Eco.Ally;
  }
  return Eco.Save;
}
