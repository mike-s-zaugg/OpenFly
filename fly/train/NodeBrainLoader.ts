import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { Connectome, ConnectomeMeta } from "../brain/Connectome";

export const OPENFLY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function loadConnectomeFromDisk(
  dir = path.join(OPENFLY_ROOT, "brain"),
  stem = "flywire783",
): Connectome {
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, `${stem}.json`), "utf8"),
  ) as ConnectomeMeta;
  const bytes = new Uint8Array(
    zlib.gunzipSync(fs.readFileSync(path.join(dir, `${stem}.bin.gz`))),
  );
  return new Connectome(meta, bytes);
}
