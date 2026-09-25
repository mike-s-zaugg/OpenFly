import { Connectome } from "../brain/Connectome";
import { Readout } from "../brain/Readout";
import type { FlyTelemetry } from "./Telemetry";

// Process-wide handles the fly executions need but the game engine does not
// know how to load: the connectome, the trained readout, and where to send
// brain activity. The worker (browser) or the trainer (Node) fills these in
// before a game starts.

let connectome: Connectome | null = null;
let readout: Readout | null = null;
let sink: ((t: FlyTelemetry) => void) | null = null;

export const FlyRegistry = {
  setConnectome(c: Connectome): void {
    connectome = c;
  },
  connectome(): Connectome {
    if (connectome === null) {
      throw new Error("OpenFly: connectome not loaded");
    }
    return connectome;
  },
  hasConnectome(): boolean {
    return connectome !== null;
  },
  setReadout(r: Readout | null): void {
    readout = r;
  },
  readout(): Readout | null {
    return readout;
  },
  setTelemetrySink(fn: ((t: FlyTelemetry) => void) | null): void {
    sink = fn;
  },
  emit(t: FlyTelemetry): void {
    sink?.(t);
  },
  hasSink(): boolean {
    return sink !== null;
  },
};
