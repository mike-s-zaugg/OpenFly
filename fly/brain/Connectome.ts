// The FlyWire game brain as typed arrays. Built by connectome/build_brain.py;
// this module only parses bytes, so it runs unchanged in the browser worker,
// on the main thread (viewer) and in Node (training).

export interface SensoryChannelMeta {
  key: string;
  label: string;
  game: string;
  why: string;
  filter: Record<string, string[]>;
  neurons: number[];
}

interface SectionMeta {
  offset: number;
  length: number;
  dtype: string;
}

export interface ConnectomeMeta {
  format: number;
  name: string;
  source: Record<string, string>;
  nAll: number;
  nSim: number;
  nEdges: number;
  minSyn: number;
  synapsesKept: number;
  posScale: number;
  posCenterUm: number[];
  superClasses: string[];
  neurotransmitters: string[];
  cellTypes: string[];
  sections: Record<string, SectionMeta>;
  channels: SensoryChannelMeta[];
  readout: number[];
  landmarks: Record<string, number[]>;
}

export class Connectome {
  readonly nAll: number;
  readonly nSim: number;
  /** Anchor positions, int16 triples in units of meta.posScale micrometres. */
  readonly pos: Int16Array;
  readonly superClass: Uint8Array;
  readonly nt: Uint8Array;
  readonly cellType: Uint16Array;
  readonly vfb: Uint32Array;
  readonly side: Uint8Array;
  /** CSR over presynaptic neurons (simulated cells only). */
  readonly rowptr: Uint32Array;
  readonly col: Uint16Array;
  /** Signed synapse counts (+ excitatory, - inhibitory). */
  readonly weight: Int16Array;
  /** Sensory channel neuron lists as typed arrays, in meta.channels order. */
  readonly channelNeurons: Uint16Array[];
  readonly readout: Uint16Array;

  constructor(
    readonly meta: ConnectomeMeta,
    bytes: Uint8Array,
  ) {
    this.nAll = meta.nAll;
    this.nSim = meta.nSim;
    const buf = bytes.buffer;
    const base = bytes.byteOffset;
    const sec = (name: string) => {
      const s = meta.sections[name];
      if (s === undefined) throw new Error(`brain file lacks section ${name}`);
      return s;
    };
    // Sections are 8-byte aligned inside the blob; copy if the blob itself is
    // not, so typed views stay valid.
    const aligned = base % 8 === 0 ? buf : bytes.slice().buffer;
    const off = base % 8 === 0 ? base : 0;
    const view = <T>(
      name: string,
      ctor: new (b: ArrayBufferLike, o: number, l: number) => T,
    ): T => {
      const s = sec(name);
      return new ctor(aligned, off + s.offset, s.length);
    };
    this.pos = view("pos", Int16Array);
    this.superClass = view("superClass", Uint8Array);
    this.nt = view("nt", Uint8Array);
    this.cellType = view("cellType", Uint16Array);
    this.vfb = view("vfb", Uint32Array);
    this.side = view("side", Uint8Array);
    this.rowptr = view("rowptr", Uint32Array);
    this.col = view("col", Uint16Array);
    this.weight = view("weight", Int16Array);
    this.channelNeurons = meta.channels.map((c) => Uint16Array.from(c.neurons));
    this.readout = Uint16Array.from(meta.readout);
  }

  channelIndex(key: string): number {
    const i = this.meta.channels.findIndex((c) => c.key === key);
    if (i < 0) throw new Error(`unknown sensory channel ${key}`);
    return i;
  }

  cellTypeName(neuron: number): string {
    return this.meta.cellTypes[this.cellType[neuron]] ?? "";
  }

  superClassName(neuron: number): string {
    return this.meta.superClasses[this.superClass[neuron]] ?? "";
  }

  vfbId(neuron: number): string | null {
    const n = this.vfb[neuron];
    return n === 0 ? null : `fw${String(n).padStart(6, "0")}`;
  }
}
