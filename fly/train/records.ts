import { FlyRecord } from "../game/FlyExecution";
import { N_ACTIONS } from "../game/Motor";

// Fixed-size binary decision records written during data collection:
//   senses f32[13] | troopRatio f32 | landShare f32 | tick u32 |
//   mask u8[N_ACTIONS] | teacher u8 | action u8 | counts u16[nReadout]

const N_SENSES = 13;

export const RECORD_BYTES = (nReadout: number) =>
  N_SENSES * 4 +
  4 +
  4 +
  4 +
  N_ACTIONS +
  2 +
  nReadout * 2 +
  ((N_ACTIONS + 2) % 2 === 1 ? 1 : 0);

export function writeRecord(
  buf: Buffer,
  rec: FlyRecord,
  nReadout: number,
): void {
  let o = 0;
  for (let i = 0; i < N_SENSES; i++, o += 4) buf.writeFloatLE(rec.senses[i], o);
  buf.writeFloatLE(rec.troopRatio, o);
  o += 4;
  buf.writeFloatLE(rec.landShare, o);
  o += 4;
  buf.writeUInt32LE(rec.tick, o);
  o += 4;
  for (let a = 0; a < N_ACTIONS; a++) buf.writeUInt8(rec.mask[a], o++);
  buf.writeUInt8(rec.teacher, o++);
  buf.writeUInt8(rec.action, o++);
  if (o % 2 === 1) o++;
  for (let j = 0; j < nReadout; j++, o += 2)
    buf.writeUInt16LE(rec.readoutCounts[j], o);
}

export interface Dataset {
  n: number;
  nReadout: number;
  senses: Float32Array; // n x 13
  mask: Uint8Array; // n x A
  teacher: Uint8Array;
  action: Uint8Array;
  counts: Uint16Array; // n x nReadout
  tick: Uint32Array;
}

export function readRecords(bufs: Buffer[], nReadout: number): Dataset {
  const size = RECORD_BYTES(nReadout);
  const n = bufs.reduce((a, b) => a + Math.floor(b.length / size), 0);
  const d: Dataset = {
    n,
    nReadout,
    senses: new Float32Array(n * N_SENSES),
    mask: new Uint8Array(n * N_ACTIONS),
    teacher: new Uint8Array(n),
    action: new Uint8Array(n),
    counts: new Uint16Array(n * nReadout),
    tick: new Uint32Array(n),
  };
  let r = 0;
  for (const buf of bufs) {
    for (let base = 0; base + size <= buf.length; base += size, r++) {
      let o = base;
      for (let i = 0; i < N_SENSES; i++, o += 4)
        d.senses[r * N_SENSES + i] = buf.readFloatLE(o);
      o += 8;
      d.tick[r] = buf.readUInt32LE(o);
      o += 4;
      for (let a = 0; a < N_ACTIONS; a++)
        d.mask[r * N_ACTIONS + a] = buf.readUInt8(o++);
      d.teacher[r] = buf.readUInt8(o++);
      d.action[r] = buf.readUInt8(o++);
      if ((o - base) % 2 === 1) o++;
      for (let j = 0; j < nReadout; j++, o += 2)
        d.counts[r * nReadout + j] = buf.readUInt16LE(o);
    }
  }
  return d;
}
