import { GameStartInfo } from "../../openfront/src/core/Schemas";
import type { FlyTelemetry } from "../game/Telemetry";
import { BrainPanel } from "../ui/BrainPanel";
import { onOpenflyTelemetry } from "./events";
import { fetchConnectome } from "./worker";

// Called by OpenFront's ClientGameRunner when a game starts. Shows the brain
// viewer for OpenFly games and returns a cleanup for when the game ends.

export function openflyMountClient(
  gameStartInfo: GameStartInfo | undefined,
): () => void {
  if (gameStartInfo?.config.openfly === undefined) return () => {};
  let panel: BrainPanel | null = null;
  let disposed = false;
  // Telemetry that arrives while the connectome is still downloading.
  const early: FlyTelemetry[] = [];
  const off = onOpenflyTelemetry((t) => {
    if (panel !== null) panel.onTelemetry(t);
    else early.push(t);
  });
  fetchConnectome(window.location.origin)
    .then((c) => {
      if (disposed) return;
      panel = new BrainPanel(c);
      for (const t of early.slice(-3)) panel.onTelemetry(t);
      early.length = 0;
    })
    .catch((e) => console.error("OpenFly: could not load the brain viewer", e));
  return () => {
    disposed = true;
    off();
    panel?.dispose();
    panel = null;
  };
}
