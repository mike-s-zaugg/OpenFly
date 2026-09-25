// Messages from a fly's brain to whoever is watching (the brain viewer on the
// main thread). Plain data plus typed arrays, so they can be posted from the
// game worker with their buffers transferred.

export interface FlyDecisionTelemetry {
  type: "openfly_decision";
  flyId: string;
  playerSmallId: number;
  name: string;
  tick: number;
  windowMs: number;
  dtMs: number;
  policy: string;
  /** Sensory channel values in [0, 1], brain channel order. */
  senses: number[];
  /** Poisson rates driven onto each channel (Hz). */
  rates: number[];
  /** Readout scores per motor program (null when no readout is loaded). */
  scores: number[] | null;
  mask: number[];
  action: number;
  teacherAction: number;
  executed: boolean;
  /** Spikes during the window: neuron index and step within the window. */
  spikeNeuron: Uint16Array;
  spikeStep: Uint16Array;
  /** Spike counts of the readout neurons (readout order). */
  readoutCounts: Uint16Array;
  totalSpikes: number;
  computeMs: number;
  stats: {
    troops: number;
    maxTroops: number;
    gold: number;
    tiles: number;
    landShare: number;
    alive: boolean;
  };
}

export interface FlyStatusTelemetry {
  type: "openfly_status";
  flyId: string;
  playerSmallId: number;
  name: string;
  tick: number;
  status: "spawned" | "died" | "won";
}

export type FlyTelemetry = FlyDecisionTelemetry | FlyStatusTelemetry;
