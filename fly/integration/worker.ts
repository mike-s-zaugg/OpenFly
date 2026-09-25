import { GameStartInfo } from "../../openfront/src/core/Schemas";
import { Connectome, ConnectomeMeta } from "../brain/Connectome";
import { Readout, ReadoutWeights } from "../brain/Readout";
import { FlyRegistry } from "../game/FlyRegistry";
import { FlyTelemetry } from "../game/Telemetry";

// Runs where OpenFront creates the game (normally its game worker): loads the
// connectome and trained readout when the game has an OpenFly mode, and
// forwards brain telemetry to the main thread.

export const OPENFLY_ASSET_BASE = "/openfly/";
const BRAIN_STEM = "flywire783";

function assetOrigin(): string {
  // The game worker is an inline blob; its location still carries the page
  // origin, which is where the dev server serves /openfly/.
  return (globalThis as { location?: Location }).location?.origin ?? "";
}

export async function fetchConnectome(
  origin = assetOrigin(),
): Promise<Connectome> {
  const base = `${origin}${OPENFLY_ASSET_BASE}`;
  const metaRes = await fetch(`${base}${BRAIN_STEM}.json`);
  if (!metaRes.ok) throw new Error(`OpenFly: brain metadata ${metaRes.status}`);
  const meta = (await metaRes.json()) as ConnectomeMeta;
  const binRes = await fetch(`${base}${BRAIN_STEM}.bin.gz`);
  if (!binRes.ok || binRes.body === null) {
    throw new Error(`OpenFly: brain data ${binRes.status}`);
  }
  const raw = new Uint8Array(await binRes.arrayBuffer());
  // Gzip magic: decompress unless the server already did.
  const bytes =
    raw[0] === 0x1f && raw[1] === 0x8b
      ? new Uint8Array(
          await new Response(
            new Blob([raw])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).arrayBuffer(),
        )
      : raw;
  return new Connectome(meta, bytes);
}

export async function fetchReadout(
  origin = assetOrigin(),
): Promise<Readout | null> {
  const res = await fetch(`${origin}${OPENFLY_ASSET_BASE}readout.json`);
  if (!res.ok) return null;
  return new Readout((await res.json()) as ReadoutWeights);
}

/** Loads the connectome and readout if this game has an OpenFly mode. */
export async function openflyLoadBrain(
  gameStartInfo: GameStartInfo,
): Promise<void> {
  if (gameStartInfo.config.openfly === undefined) return;
  if (!FlyRegistry.hasConnectome()) {
    FlyRegistry.setConnectome(await fetchConnectome());
  }
  if (FlyRegistry.readout() === null) {
    try {
      FlyRegistry.setReadout(await fetchReadout());
    } catch (e) {
      console.warn(
        "OpenFly: no trained readout, the teacher policy will drive",
        e,
      );
    }
  }
}

/** Sends fly telemetry from the game worker to the main thread. */
export function openflyWorkerSink(
  post: (message: FlyTelemetry, transfer: Transferable[]) => void,
): void {
  FlyRegistry.setTelemetrySink((t) => {
    const transfer: Transferable[] =
      t.type === "openfly_decision"
        ? [t.spikeNeuron.buffer, t.spikeStep.buffer, t.readoutCounts.buffer]
        : [];
    post(t, transfer);
  });
}
