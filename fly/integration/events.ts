import type { FlyTelemetry } from "../game/Telemetry";

// Bridge from OpenFront's WorkerClient (main thread) to the brain viewer:
// fly telemetry arrives as worker messages and is re-dispatched as a window
// event, so nothing in OpenFront has to know what the viewer does with it.

export const OPENFLY_EVENT = "openfly-telemetry";

export function isOpenflyTelemetry(message: unknown): message is FlyTelemetry {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("openfly_");
}

export function dispatchOpenflyTelemetry(message: FlyTelemetry): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FlyTelemetry>(OPENFLY_EVENT, { detail: message }),
  );
}

export function onOpenflyTelemetry(fn: (t: FlyTelemetry) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<FlyTelemetry>).detail);
  window.addEventListener(OPENFLY_EVENT, handler);
  return () => window.removeEventListener(OPENFLY_EVENT, handler);
}
