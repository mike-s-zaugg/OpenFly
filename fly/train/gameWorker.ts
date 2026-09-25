// Child process: plays one headless game described by a JSON spec (argv[2]),
// optionally recording every decision to a binary file, and prints the
// result as the last stdout line prefixed with RESULT.
import fs from "node:fs";
import { Readout, ReadoutWeights } from "../brain/Readout";
import { FlyRecord } from "../game/FlyExecution";
import { FlyRegistry } from "../game/FlyRegistry";
import { HeadlessGameSpec, playHeadless } from "./HeadlessGame";
import { loadConnectomeFromDisk } from "./NodeBrainLoader";
import { RECORD_BYTES, writeRecord } from "./records";

interface WorkerSpec extends HeadlessGameSpec {
  readoutPath?: string;
  recordPath?: string;
}

const spec = JSON.parse(process.argv[2]) as WorkerSpec;
console.debug = () => {};
console.log = () => {};
console.warn = () => {};
console.info = () => {};

const conn = loadConnectomeFromDisk();
FlyRegistry.setConnectome(conn);
if (spec.readoutPath) {
  FlyRegistry.setReadout(
    new Readout(
      JSON.parse(fs.readFileSync(spec.readoutPath, "utf8")) as ReadoutWeights,
    ),
  );
}

const chunks: Buffer[] = [];
const recorder =
  spec.recordPath === undefined
    ? undefined
    : (rec: FlyRecord) => {
        const buf = Buffer.alloc(RECORD_BYTES(conn.readout.length));
        writeRecord(buf, rec, conn.readout.length);
        chunks.push(buf);
      };

const result = await playHeadless({ ...spec, fly: { ...spec.fly, recorder } });
if (spec.recordPath !== undefined) {
  fs.writeFileSync(spec.recordPath, Buffer.concat(chunks));
}
process.stdout.write(
  `RESULT ${JSON.stringify({ ...result, records: chunks.length })}\n`,
);
