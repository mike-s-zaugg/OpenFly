import { FlyRecord } from "../game/FlyExecution";
import { N_ECO, N_MIL } from "../game/Motor";
import { N_SENSES } from "../game/Senses";

// Fixed-size binary decision records written during data collection:
//   senses f32[N_SENSES] | troopRatio f32 | landShare f32 | tick u32 |
//   milMask u8[N_MIL] | ecoMask u8[N_ECO] |
//   milTeacher u8 | ecoTeacher u8 | milAction u8 | ecoAction u8 |
//   (pad to even) | counts u16[nReadout]

const HEADER = N_SENSES * 4 + 12 + N_MIL + N_ECO + 4;
const PAD = HEADER % 2;

export const RECORD_BYTES = (nReadout: number) => HEADER + PAD + nReadout * 2;

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
  for (let a = 0; a < N_MIL; a++) buf.writeUInt8(rec.milMask[a], o++);
  for (let a = 0; a < N_ECO; a++) buf.writeUInt8(rec.ecoMask[a], o++);
  buf.writeUInt8(rec.milTeacher, o++);
  buf.writeUInt8(rec.ecoTeacher, o++);
  buf.writeUInt8(rec.milAction, o++);
  buf.writeUInt8(rec.ecoAction, o++);
  o += PAD;
  for (let j = 0; j < nReadout; j++, o += 2) {
    buf.writeUInt16LE(rec.readoutCounts[j], o);
  }
}

/** Labels and feasibility masks of one motor head. */
export interface HeadData {
  nActions: number;
  mask: Uint8Array; // n x nActions
  teacher: Uint8Array;
  action: Uint8Array;
}

export interface Dataset {
  n: number;
  nReadout: number;
  senses: Float32Array; // n x N_SENSES
  counts: Uint16Array; // n x nReadout
  tick: Uint32Array;
  heads: [HeadData, HeadData]; // military, economy
}

export function readRecords(bufs: Buffer[], nReadout: number): Dataset {
  const size = RECORD_BYTES(nReadout);
  const n = bufs.reduce((a, b) => a + Math.floor(b.length / size), 0);
  const head = (nActions: number): HeadData => ({
    nActions,
    mask: new Uint8Array(n * nActions),
    teacher: new Uint8Array(n),
    action: new Uint8Array(n),
  });
  const d: Dataset = {
    n,
    nReadout,
    senses: new Float32Array(n * N_SENSES),
    counts: new Uint16Array(n * nReadout),
    tick: new Uint32Array(n),
    heads: [head(N_MIL), head(N_ECO)],
  };
  const [mil, eco] = d.heads;
  let r = 0;
  for (const buf of bufs) {
    for (let base = 0; base + size <= buf.length; base += size, r++) {
      let o = base;
      for (let i = 0; i < N_SENSES; i++, o += 4) {
        d.senses[r * N_SENSES + i] = buf.readFloatLE(o);
      }
      o += 8;
      d.tick[r] = buf.readUInt32LE(o);
      o += 4;
      for (let a = 0; a < N_MIL; a++) mil.mask[r * N_MIL + a] = buf.readUInt8(o++);
      for (let a = 0; a < N_ECO; a++) eco.mask[r * N_ECO + a] = buf.readUInt8(o++);
      mil.teacher[r] = buf.readUInt8(o++);
      eco.teacher[r] = buf.readUInt8(o++);
      mil.action[r] = buf.readUInt8(o++);
      eco.action[r] = buf.readUInt8(o++);
      o += PAD;
      for (let j = 0; j < nReadout; j++, o += 2) {
        d.counts[r * nReadout + j] = buf.readUInt16LE(o);
      }
    }
  }
  return d;
}
