import { PseudoRandom } from "../../openfront/src/core/PseudoRandom";
import { Action } from "./Motor";
import { Situation } from "./Senses";

// A hand-written policy used only to train the brain's readout: the fly
// watches these choices while its connectome processes the same senses, and
// the readout learns to produce them from descending-neuron activity alone.
// It plays like a sensible human: grab free land early, keep troops near the
// growth sweet spot, turn gold into cities, punish weak neighbours, and
// build defenses when something big is coming.

export interface TeacherParams {
  expandAt: number;
  attackAt: number;
  weakRatio: number;
  boatAt: number;
  citySlack: number;
}

export const DEFAULT_TEACHER: TeacherParams = {
  expandAt: 0.22,
  attackAt: 0.5,
  weakRatio: 0.75,
  boatAt: 0.55,
  citySlack: 1.0,
};

export function teacherAction(
  s: Situation,
  mask: Uint8Array,
  random: PseudoRandom,
  p: TeacherParams = DEFAULT_TEACHER,
): Action {
  const r = s.troopRatio;
  const threat = s.incomingTroops / Math.max(1, s.troops);
  const can = (a: Action) => mask[a] === 1;

  // Danger first.
  if (threat > 0.4 && can(Action.Defend) && s.defensePosts < 2 + s.cities) {
    return Action.Defend;
  }
  if (
    can(Action.Retaliate) &&
    s.mainAttacker !== null &&
    r > 0.3 &&
    s.mainAttacker.troops() < 1.3 * s.troops
  ) {
    return Action.Retaliate;
  }
  if (can(Action.Ally) && s.allianceRequests.length > 0) {
    return Action.Ally;
  }

  // Economy: gold is only useful once spent.
  if (can(Action.City) && s.gold >= s.cityCost * p.citySlack) {
    // Coastal empires alternate ports in for trade income.
    if (can(Action.Port) && s.ports < 1 + Math.floor(s.cities / 2)) {
      return Action.Port;
    }
    return Action.City;
  }
  if (can(Action.Port) && s.ports === 0 && s.cities >= 1) {
    return Action.Port;
  }
  if (can(Action.Factory) && s.cities >= 4 && random.chance(3)) {
    return Action.Factory;
  }

  // Growth.
  if (can(Action.Expand) && r > p.expandAt) {
    return Action.Expand;
  }
  if (can(Action.Attack) && s.bots.length > 0 && r > 0.3) {
    return Action.Attack;
  }
  if (
    can(Action.Attack) &&
    s.weakest !== null &&
    r > p.attackAt &&
    s.weakest.troops() < p.weakRatio * s.troops
  ) {
    return Action.Attack;
  }
  // Boats only when there is nothing to take by land: an island, or a
  // coast where every land neighbour is too strong. One boat at a time.
  if (
    can(Action.Boat) &&
    s.boatsOut === 0 &&
    s.freeBorder === 0 &&
    s.bots.length === 0 &&
    (s.enemies.length === 0 ? r > p.boatAt : r > 0.85)
  ) {
    return Action.Boat;
  }
  // Stalemate against stronger neighbours: ask the strongest for peace once
  // in a while, otherwise save up.
  if (
    can(Action.Ally) &&
    s.strongest !== null &&
    s.strongest.troops() > 1.5 * s.troops &&
    random.chance(8)
  ) {
    return Action.Ally;
  }
  if (can(Action.Defend) && r > 0.9 && s.defensePosts < s.cities && random.chance(4)) {
    return Action.Defend;
  }
  return Action.Wait;
}
