import { z } from "zod";
import { SpawnExecution } from "../../openfront/src/core/execution/SpawnExecution";
import {
  Execution,
  Game,
  Player,
  PlayerInfo,
} from "../../openfront/src/core/game/Game";
import { TileRef } from "../../openfront/src/core/game/GameMap";
import { PseudoRandom } from "../../openfront/src/core/PseudoRandom";
import {
  PlayerInfoSchema,
  playerInfoData,
  readPlayerInfo,
} from "../../openfront/src/core/snapshot/CommonSchemas";
import { execSnapshotType } from "../../openfront/src/core/snapshot/ExecutionSnapshot";
import { zRandom } from "../../openfront/src/core/snapshot/SnapshotType";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../openfront/src/core/snapshot/SnapshotContext";
import { simpleHash } from "../../openfront/src/core/Util";
import { LIFBrain } from "../brain/LIFBrain";
import { maskedArgmax, maskedSoftmax, Readout } from "../brain/Readout";
import { FlyRegistry } from "./FlyRegistry";
import { Action, Motor, N_ACTIONS } from "./Motor";
import { senses, survey } from "./Senses";
import { teacherAction } from "./Teacher";

export type FlyPolicy = "brain" | "teacher" | "dagger";

export interface FlyOptions {
  /**
   * brain: the readout of descending-neuron activity picks the motor program.
   * teacher: the heuristic picks (the brain still runs; used for recording).
   * dagger: teacher with probability daggerBeta, brain otherwise.
   */
  policy: FlyPolicy;
  daggerBeta: number;
  /** Game ticks between decisions (10 ticks = 1 s of game time). */
  decisionTicks: number;
  /** Simulated brain time per decision. */
  windowMs: number;
  /** Peak Poisson rate for a sensory channel at value 1 (Shiu et al.: 150 Hz). */
  maxRateHz: number;
  /** Softmax temperature for the readout; 0 = always the top score. */
  temperature: number;
  /** Stream brain activity to FlyRegistry's sink (the viewer). */
  telemetry: boolean;
  /** Ticks to look at the map before choosing where to land. */
  spawnDelayTicks: number;
  recorder?: (rec: FlyRecord) => void;
}

export const DEFAULT_FLY_OPTIONS: FlyOptions = {
  policy: "brain",
  daggerBeta: 0.5,
  decisionTicks: 15,
  windowMs: 100,
  maxRateHz: 150,
  temperature: 0,
  telemetry: false,
  spawnDelayTicks: 20,
};

export interface FlyRecord {
  tick: number;
  senses: Float32Array;
  readoutCounts: Uint16Array;
  mask: Uint8Array;
  teacher: number;
  action: number;
  troopRatio: number;
  landShare: number;
}

export class FlyExecution implements Execution {
  private active = true;
  private mg: Game;
  private player: Player | null = null;
  private random: PseudoRandom;
  private brain: LIFBrain | null = null;
  private motor: Motor | null = null;
  private spawnRequestedAt = -1;
  private decisionPhase = 0;
  private reportedSpawn = false;
  options: FlyOptions;

  private senseBuf = new Float32Array(13);
  private maskBuf = new Uint8Array(N_ACTIONS);
  private scoreBuf = new Float32Array(N_ACTIONS);
  private probBuf = new Float32Array(N_ACTIONS);
  private spikeNeuron = new Uint16Array(1 << 15);
  private spikeStep = new Uint16Array(1 << 15);
  private nSpikes = 0;

  decisions = 0;
  computeMsTotal = 0;
  actionCounts = new Array<number>(N_ACTIONS).fill(0);

  constructor(
    private playerInfo: PlayerInfo,
    private gameID: string,
    options: Partial<FlyOptions> = {},
  ) {
    this.options = { ...DEFAULT_FLY_OPTIONS, ...options };
    this.random = new PseudoRandom(
      simpleHash(playerInfo.id) + simpleHash(gameID) + 0x0f1e5,
    );
    this.decisionPhase = this.random.nextInt(0, this.options.decisionTicks);
  }

  flyId(): string {
    return this.playerInfo.id;
  }

  flyPlayer(): Player | null {
    return this.player;
  }

  init(mg: Game): void {
    this.mg = mg;
    this.player = mg.hasPlayer(this.playerInfo.id)
      ? mg.player(this.playerInfo.id)
      : mg.addPlayer(this.playerInfo);
    this.brain = new LIFBrain(
      FlyRegistry.connectome(),
      simpleHash(this.gameID + this.playerInfo.id) >>> 0,
    );
    this.motor = new Motor(mg, this.player, this.random);
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  isActive(): boolean {
    return this.active;
  }

  tick(ticks: number): void {
    const me = this.player;
    if (me === null) return;

    if (!me.hasSpawned()) {
      this.trySpawn(ticks);
      return;
    }
    if (!this.reportedSpawn) {
      this.reportedSpawn = true;
      this.status("spawned");
    }
    if (this.mg.inSpawnPhase()) return;
    if (!me.isAlive()) {
      this.status("died");
      this.active = false;
      return;
    }
    if (ticks % this.options.decisionTicks !== this.decisionPhase) return;
    this.decide(ticks);
  }

  private trySpawn(ticks: number): void {
    if (!this.mg.inSpawnPhase()) {
      // Missed the spawn phase (e.g. restored late); nothing to control.
      this.active = false;
      return;
    }
    if (ticks < this.options.spawnDelayTicks) return;
    // Wait for the previous attempt to land before trying another spot.
    if (this.spawnRequestedAt >= 0 && ticks - this.spawnRequestedAt < 3) return;
    this.spawnRequestedAt = ticks;
    const tile = chooseSpawnTile(this.mg, this.random, this.playerInfo.id);
    this.mg.addExecution(
      new SpawnExecution(this.gameID, this.playerInfo, tile ?? undefined),
    );
  }

  private decide(ticks: number): void {
    const me = this.player!;
    const brain = this.brain!;
    const motor = this.motor!;
    const t0 = performance.now();

    const sit = survey(this.mg, me);
    const sense = senses(sit, this.senseBuf);
    const mask = motor.feasible(sit, this.maskBuf);

    // Senses -> Poisson drive on the sensory channels.
    const rates: number[] = [];
    for (let ch = 0; ch < sense.length; ch++) {
      const hz = this.options.maxRateHz * sense[ch];
      brain.setChannelRate(ch, hz);
      rates.push(hz);
    }
    brain.resetCounts();
    this.nSpikes = 0;
    const record = this.options.telemetry && FlyRegistry.hasSink();
    brain.runMs(
      this.options.windowMs,
      record ? (step, neuron) => this.recordSpike(step, neuron) : undefined,
    );

    const readout = FlyRegistry.readout();
    const teacher = teacherAction(sit, mask, this.random);
    let scores: Float32Array | null = null;
    let action: Action;
    let policy: string = this.options.policy;
    if (readout !== null) {
      scores = readout.scores(brain.counts, this.scoreBuf);
    }
    const brainPick = (): Action => {
      if (scores === null) return teacher;
      if (this.options.temperature <= 0) return maskedArgmax(scores, mask);
      const tempScores = scores.map((s) => s / this.options.temperature);
      const p = maskedSoftmax(tempScores, mask, this.probBuf);
      let u = this.random.next();
      for (let a = 0; a < p.length; a++) {
        u -= p[a];
        if (u <= 0) return a;
      }
      return Action.Wait;
    };
    switch (this.options.policy) {
      case "teacher":
        action = teacher;
        break;
      case "dagger":
        action = this.random.next() < this.options.daggerBeta ? teacher : brainPick();
        break;
      case "brain":
      default:
        action = brainPick();
        if (scores === null) policy = "teacher (no readout loaded)";
        break;
    }

    const executed = motor.execute(action, sit);
    this.decisions++;
    this.computeMsTotal += performance.now() - t0;
    this.actionCounts[action]++;

    const conn = brain.connectome;
    if (this.options.recorder !== undefined) {
      this.options.recorder({
        tick: ticks,
        senses: Float32Array.from(sense),
        readoutCounts: Uint16Array.from(conn.readout, (i) => brain.counts[i]),
        mask: Uint8Array.from(mask),
        teacher,
        action,
        troopRatio: sit.troopRatio,
        landShare: sit.landShare,
      });
    }

    if (record) {
      FlyRegistry.emit({
        type: "openfly_decision",
        flyId: this.playerInfo.id,
        playerSmallId: me.smallID(),
        name: me.displayName(),
        tick: ticks,
        windowMs: this.options.windowMs,
        dtMs: brain.params.dtMs,
        policy,
        senses: Array.from(sense),
        rates,
        scores: scores === null ? null : Array.from(scores),
        mask: Array.from(mask),
        action,
        teacherAction: teacher,
        executed,
        spikeNeuron: this.spikeNeuron.slice(0, this.nSpikes),
        spikeStep: this.spikeStep.slice(0, this.nSpikes),
        readoutCounts: Uint16Array.from(conn.readout, (i) => brain.counts[i]),
        totalSpikes: this.nSpikes,
        computeMs: performance.now() - t0,
        stats: {
          troops: sit.troops,
          maxTroops: sit.maxTroops,
          gold: sit.gold,
          tiles: sit.tilesOwned,
          landShare: sit.landShare,
          alive: me.isAlive(),
        },
      });
    }
  }

  private recordSpike(step: number, neuron: number): void {
    if (this.nSpikes === this.spikeNeuron.length) {
      const n = new Uint16Array(this.spikeNeuron.length * 2);
      n.set(this.spikeNeuron);
      this.spikeNeuron = n;
      const s = new Uint16Array(this.spikeStep.length * 2);
      s.set(this.spikeStep);
      this.spikeStep = s;
    }
    this.spikeNeuron[this.nSpikes] = neuron;
    this.spikeStep[this.nSpikes] = step;
    this.nSpikes++;
  }

  private status(status: "spawned" | "died" | "won"): void {
    if (!this.options.telemetry || this.player === null) return;
    FlyRegistry.emit({
      type: "openfly_status",
      flyId: this.playerInfo.id,
      playerSmallId: this.player.smallID(),
      name: this.player.displayName(),
      tick: this.mg.ticks(),
      status,
    });
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    // Neural state is not saved: a restored fly wakes up with a quiet brain.
    return FlyExecutionSnapshot.write({
      active: this.active,
      gameID: this.gameID,
      playerInfo: playerInfoData(this.playerInfo),
      random: w.random(this.random),
      initialized: this.mg !== undefined,
      options: {
        policy: this.options.policy,
        decisionTicks: this.options.decisionTicks,
        windowMs: this.options.windowMs,
        telemetry: this.options.telemetry,
      },
      decisionPhase: this.decisionPhase,
      spawnRequestedAt: this.spawnRequestedAt,
      reportedSpawn: this.reportedSpawn,
    });
  }

  restoreSnapshot(s: FlyState, r: SnapshotReader): void {
    this.active = s.active;
    this.gameID = s.gameID;
    this.playerInfo = readPlayerInfo(s.playerInfo, r);
    this.random = r.random(s.random);
    this.options = {
      ...DEFAULT_FLY_OPTIONS,
      ...s.options,
    };
    this.decisionPhase = s.decisionPhase;
    this.spawnRequestedAt = s.spawnRequestedAt;
    this.reportedSpawn = s.reportedSpawn;
    this.decisions = 0;
    this.actionCounts = new Array<number>(N_ACTIONS).fill(0);
    this.spikeNeuron = new Uint16Array(1 << 15);
    this.spikeStep = new Uint16Array(1 << 15);
    this.nSpikes = 0;
    this.senseBuf = new Float32Array(13);
    this.maskBuf = new Uint8Array(N_ACTIONS);
    this.scoreBuf = new Float32Array(N_ACTIONS);
    this.probBuf = new Float32Array(N_ACTIONS);
    if (s.initialized) {
      this.mg = r.game;
      this.player = this.mg.hasPlayer(this.playerInfo.id)
        ? this.mg.player(this.playerInfo.id)
        : null;
      this.brain = FlyRegistry.hasConnectome()
        ? new LIFBrain(
            FlyRegistry.connectome(),
            simpleHash(this.gameID + this.playerInfo.id) >>> 0,
          )
        : null;
      this.motor =
        this.player === null ? null : new Motor(this.mg, this.player, this.random);
      if (this.brain === null) this.active = false;
    } else {
      this.player = null;
      this.brain = null;
      this.motor = null;
    }
  }
}

/**
 * Landing site: the candidate with the most unclaimed land around it and no
 * one else close by.
 */
export function chooseSpawnTile(
  g: Game,
  random: PseudoRandom,
  selfId: string,
): TileRef | null {
  const minDist = g.config().minDistanceBetweenPlayers();
  const others: TileRef[] = [];
  for (const p of g.allPlayers()) {
    if (p.id() === selfId) continue;
    const st = p.spawnTile();
    if (st !== undefined) others.push(st);
  }
  let best: TileRef | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 400; i++) {
    // 80 candidates are plenty; keep looking only while nothing fits.
    if (i >= 80 && best !== null) break;
    const x = random.nextInt(0, g.width());
    const y = random.nextInt(0, g.height());
    const t = g.ref(x, y);
    if (!g.isLand(t) || g.hasOwner(t) || g.isBorder(t) || g.isImpassable(t)) continue;
    let nearest = Infinity;
    for (const o of others) nearest = Math.min(nearest, g.manhattanDist(o, t));
    if (nearest < minDist) continue;
    // Free land within ~60 tiles, sampled on rings.
    let free = 0;
    let total = 0;
    for (let ring = 1; ring <= 4; ring++) {
      const r = ring * 15;
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2 + ring;
        const sx = Math.round(x + r * Math.cos(ang));
        const sy = Math.round(y + r * Math.sin(ang));
        total++;
        if (!g.isValidCoord(sx, sy)) continue;
        const st = g.ref(sx, sy);
        if (g.isLand(st) && !g.hasOwner(st) && !g.isImpassable(st)) free++;
      }
    }
    const score = free / total + Math.min(nearest, 300) / 600 + 0.05 * random.next();
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

const FlyStateSchema = z.object({
  active: z.boolean(),
  gameID: z.string(),
  playerInfo: PlayerInfoSchema,
  random: zRandom(),
  initialized: z.boolean(),
  options: z.object({
    policy: z.enum(["brain", "teacher", "dagger"]),
    decisionTicks: z.number(),
    windowMs: z.number(),
    telemetry: z.boolean(),
  }),
  decisionPhase: z.number(),
  spawnRequestedAt: z.number(),
  reportedSpawn: z.boolean(),
});
type FlyState = z.infer<typeof FlyStateSchema>;

export const FlyExecutionSnapshot = execSnapshotType({
  name: "OpenFly",
  version: 1,
  schema: FlyStateSchema,
  cls: () => FlyExecution,
});
