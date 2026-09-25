import { z } from "zod";
import { SpawnExecution } from "../../openfront/src/core/execution/SpawnExecution";
import {
  Execution,
  Game,
  Player,
  PlayerInfo,
  UnitType,
} from "../../openfront/src/core/game/Game";
import { TileRef } from "../../openfront/src/core/game/GameMap";
import { PseudoRandom } from "../../openfront/src/core/PseudoRandom";
import {
  playerInfoData,
  PlayerInfoSchema,
  readPlayerInfo,
} from "../../openfront/src/core/snapshot/CommonSchemas";
import { execSnapshotType } from "../../openfront/src/core/snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../openfront/src/core/snapshot/SnapshotContext";
import { zRandom } from "../../openfront/src/core/snapshot/SnapshotType";
import { simpleHash } from "../../openfront/src/core/Util";
import { LIFBrain } from "../brain/LIFBrain";
import { maskedArgmax, maskedSoftmax } from "../brain/Readout";
import { FlyRegistry } from "./FlyRegistry";
import { Eco, HEADS, Mil, Motor, N_ECO, N_MIL } from "./Motor";
import { N_SENSES, senses, Situation, survey } from "./Senses";
import {
  DEFAULT_TEACHER,
  TeacherParams,
  teacherEconomy,
  teacherMilitary,
} from "./Teacher";
import { FlyHeadTelemetry } from "./Telemetry";

export type FlyPolicy = "brain" | "teacher" | "dagger";

export interface FlyOptions {
  /**
   * brain: readouts of descending-neuron activity pick the motor programs.
   * teacher: the heuristic picks (the brain still runs; used for recording).
   * dagger: teacher with probability daggerBeta, brain otherwise.
   */
  policy: FlyPolicy;
  daggerBeta: number;
  /** Game ticks between decisions (10 ticks = 1 s of game time). */
  decisionTicks: number;
  /** Simulated brain time per decision. */
  windowMs: number;
  /**
   * Game ticks each decision window is spread over. The brain "thinks" for
   * this long before acting, and no single game tick pays for a whole window,
   * which keeps the game smooth on slow machines.
   */
  sliceTicks: number;
  /** Peak Poisson rate for a sensory channel at value 1 (Shiu et al.: 150 Hz). */
  maxRateHz: number;
  /** Softmax temperature for the readout; 0 = always the top score. */
  temperature: number;
  /** Stream brain activity to FlyRegistry's sink (the viewer). */
  telemetry: boolean;
  /** Ticks to look at the map before choosing where to land. */
  spawnDelayTicks: number;
  /** Overrides for the teacher's rules (training and tuning only). */
  teacherParams?: Partial<TeacherParams>;
  recorder?: (rec: FlyRecord) => void;
}

export const DEFAULT_FLY_OPTIONS: FlyOptions = {
  policy: "brain",
  daggerBeta: 0.5,
  decisionTicks: 15,
  windowMs: 100,
  sliceTicks: 5,
  maxRateHz: 150,
  temperature: 0,
  telemetry: false,
  spawnDelayTicks: 20,
};

export interface FlyRecord {
  tick: number;
  senses: Float32Array;
  readoutCounts: Uint16Array;
  milMask: Uint8Array;
  ecoMask: Uint8Array;
  milTeacher: number;
  ecoTeacher: number;
  milAction: number;
  ecoAction: number;
  troopRatio: number;
  landShare: number;
}

/** A decision whose brain window is still being simulated. */
interface Pending {
  tick: number;
  sit: Situation;
  senses: Float32Array;
  rates: number[];
  milMask: Uint8Array;
  ecoMask: Uint8Array;
  milTeacher: Mil;
  ecoTeacher: Eco;
  steps: number;
  stepsDone: number;
  computeMs: number;
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
  private reportedWin = false;
  private pending: Pending | null = null;
  options: FlyOptions;

  private spikeNeuron = new Uint16Array(1 << 15);
  private spikeStep = new Uint16Array(1 << 15);
  private nSpikes = 0;

  decisions = 0;
  computeMsTotal = 0;
  /** Longest single-tick brain cost seen, in ms. */
  maxTickMs = 0;
  milCounts = new Array<number>(N_MIL).fill(0);
  ecoCounts = new Array<number>(N_ECO).fill(0);

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
    if (!this.reportedWin && this.mg.getWinner() === me) {
      this.reportedWin = true;
      this.status("won");
    }
    if (!me.isAlive()) {
      this.status("died");
      this.active = false;
      return;
    }
    if (this.pending === null) {
      if (ticks % this.options.decisionTicks !== this.decisionPhase) return;
      this.beginDecision(ticks);
    }
    this.think();
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

  /** Sense the world and start a brain window. */
  private beginDecision(ticks: number): void {
    const t0 = performance.now();
    const me = this.player!;
    const brain = this.brain!;
    const motor = this.motor!;
    const sit = survey(this.mg, me);
    const sense = senses(sit, new Float32Array(N_SENSES));
    const milMask = motor.feasibleMilitary(sit);
    const ecoMask = motor.feasibleEconomy(sit);
    const rates: number[] = [];
    for (let ch = 0; ch < sense.length; ch++) {
      const hz = this.options.maxRateHz * sense[ch];
      brain.setChannelRate(ch, hz);
      rates.push(hz);
    }
    brain.resetCounts();
    this.nSpikes = 0;
    const atom = this.mg.config().isUnitDisabled(UnitType.AtomBomb)
      ? Number.POSITIVE_INFINITY
      : Number(this.mg.config().unitInfo(UnitType.AtomBomb).cost(this.mg, me));
    this.pending = {
      tick: ticks,
      sit,
      senses: sense,
      rates,
      milMask,
      ecoMask,
      milTeacher: teacherMilitary(sit, milMask, me, { atom }, this.teacherParams()),
      ecoTeacher: teacherEconomy(
        sit,
        ecoMask,
        this.random,
        { atom },
        this.teacherParams(),
      ),
      steps: Math.round(this.options.windowMs / brain.params.dtMs),
      stepsDone: 0,
      computeMs: performance.now() - t0,
    };
  }

  private teacherParams(): TeacherParams {
    return { ...DEFAULT_TEACHER, ...this.options.teacherParams };
  }

  /** Simulate this tick's share of the window; act once it is complete. */
  private think(): void {
    const p = this.pending!;
    const brain = this.brain!;
    const t0 = performance.now();
    const slice = Math.ceil(p.steps / Math.max(1, this.options.sliceTicks));
    const n = Math.min(slice, p.steps - p.stepsDone);
    const record = this.options.telemetry && FlyRegistry.hasSink();
    brain.run(
      n,
      record ? (step, neuron) => this.recordSpike(step, neuron) : undefined,
      p.stepsDone,
    );
    p.stepsDone += n;
    const dt = performance.now() - t0;
    p.computeMs += dt;
    this.maxTickMs = Math.max(this.maxTickMs, dt);
    if (p.stepsDone >= p.steps) {
      this.pending = null;
      this.act(p);
    }
  }

  private pick(
    scores: Float32Array | null,
    mask: Uint8Array,
    teacher: number,
  ): number {
    if (scores === null) return teacher;
    if (this.options.temperature <= 0) return maskedArgmax(scores, mask);
    const p = maskedSoftmax(
      scores.map((s) => s / this.options.temperature),
      mask,
    );
    let u = this.random.next();
    for (let a = 0; a < p.length; a++) {
      u -= p[a];
      if (u <= 0) return a;
    }
    return 0;
  }

  private act(p: Pending): void {
    const t0 = performance.now();
    const me = this.player!;
    const brain = this.brain!;
    const motor = this.motor!;
    const readout = FlyRegistry.readout();
    const scores = readout === null ? null : readout.scores(brain.counts);
    let policy: string = this.options.policy;
    let mil: Mil;
    let eco: Eco;
    const brainMil = () => this.pick(scores?.[0] ?? null, p.milMask, p.milTeacher);
    const brainEco = () => this.pick(scores?.[1] ?? null, p.ecoMask, p.ecoTeacher);
    switch (this.options.policy) {
      case "teacher":
        mil = p.milTeacher;
        eco = p.ecoTeacher;
        break;
      case "dagger": {
        const useTeacher = this.random.next() < this.options.daggerBeta;
        mil = useTeacher ? p.milTeacher : brainMil();
        eco = useTeacher ? p.ecoTeacher : brainEco();
        break;
      }
      case "brain":
      default:
        mil = brainMil();
        eco = brainEco();
        if (scores === null) policy = "teacher (no readout loaded)";
        break;
    }

    // The world moved on while the brain was thinking: act on a fresh look,
    // and skip a program the body can no longer run.
    const now = survey(this.mg, me);
    const milOk =
      motor.feasibleMilitary(now)[mil] === 1 && motor.military(mil, now);
    const ecoOk =
      motor.feasibleEconomy(now)[eco] === 1 && motor.economy(eco, now);
    this.decisions++;
    this.milCounts[mil]++;
    this.ecoCounts[eco]++;
    p.computeMs += performance.now() - t0;
    this.computeMsTotal += p.computeMs;

    const conn = brain.connectome;
    if (this.options.recorder !== undefined) {
      this.options.recorder({
        tick: p.tick,
        senses: p.senses,
        readoutCounts: Uint16Array.from(conn.readout, (i) => brain.counts[i]),
        milMask: p.milMask,
        ecoMask: p.ecoMask,
        milTeacher: p.milTeacher,
        ecoTeacher: p.ecoTeacher,
        milAction: mil,
        ecoAction: eco,
        troopRatio: p.sit.troopRatio,
        landShare: p.sit.landShare,
      });
    }

    if (this.options.telemetry && FlyRegistry.hasSink()) {
      const heads: FlyHeadTelemetry[] = [
        {
          key: HEADS[0].key,
          scores: scores === null ? null : Array.from(scores[0]),
          mask: Array.from(p.milMask),
          action: mil,
          teacher: p.milTeacher,
          executed: milOk,
        },
        {
          key: HEADS[1].key,
          scores: scores === null ? null : Array.from(scores[1]),
          mask: Array.from(p.ecoMask),
          action: eco,
          teacher: p.ecoTeacher,
          executed: ecoOk,
        },
      ];
      FlyRegistry.emit({
        type: "openfly_decision",
        flyId: this.playerInfo.id,
        playerSmallId: me.smallID(),
        name: me.displayName(),
        tick: p.tick,
        windowMs: this.options.windowMs,
        dtMs: brain.params.dtMs,
        policy,
        senses: Array.from(p.senses),
        rates: p.rates,
        heads,
        spikeNeuron: this.spikeNeuron.slice(0, this.nSpikes),
        spikeStep: this.spikeStep.slice(0, this.nSpikes),
        readoutCounts: Uint16Array.from(conn.readout, (i) => brain.counts[i]),
        totalSpikes: this.nSpikes,
        computeMs: p.computeMs,
        stats: {
          troops: now.troops,
          maxTroops: now.maxTroops,
          gold: now.gold,
          tiles: now.tilesOwned,
          landShare: now.landShare,
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
    // Neural state is not saved: a restored fly wakes up with a quiet brain
    // and drops a decision it was still thinking about.
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
    this.reportedWin = false;
    this.pending = null;
    this.decisions = 0;
    this.computeMsTotal = 0;
    this.maxTickMs = 0;
    this.milCounts = new Array<number>(N_MIL).fill(0);
    this.ecoCounts = new Array<number>(N_ECO).fill(0);
    this.spikeNeuron = new Uint16Array(1 << 15);
    this.spikeStep = new Uint16Array(1 << 15);
    this.nSpikes = 0;
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
        this.player === null
          ? null
          : new Motor(this.mg, this.player, this.random);
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
    if (!g.isLand(t) || g.hasOwner(t) || g.isBorder(t) || g.isImpassable(t))
      continue;
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
    const score =
      free / total + Math.min(nearest, 300) / 600 + 0.05 * random.next();
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
