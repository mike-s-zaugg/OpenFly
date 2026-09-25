#!/usr/bin/env python3
"""Build the OpenFly game brain from the FlyWire 783 connectome.

The output is a compact binary + JSON pair that the TypeScript simulator
(fly/brain/Connectome.ts) loads in the browser worker and in Node training.

What gets simulated
    Every neuron outside the optic lobes: central brain, visual projection
    neurons, ascending/descending neurons, non-photoreceptor sensory neurons,
    motor and endocrine neurons (~50.6k cells). The optic lobes and the
    compound-eye photoreceptors (~88.7k cells) are stored with their positions
    only, so the viewer can draw the whole brain while the game-relevant part
    runs. With fewer than 65,536 simulated cells, synapse targets fit in a
    Uint16.

Synapses
    Neuron pairs with at least MIN_SYN synapses are kept (79.7% of all
    synapses between simulated cells at MIN_SYN=3). Weights are signed
    synapse counts. The sign comes from each presynaptic neuron's transmitter:
    GABA, glutamate and histamine inhibit, everything else excites (the
    convention of Shiu et al.). The transmitter is the experimentally known
    one when the annotation table has it (known_nt), otherwise the predicted
    top_nt. The known transmitters matter: several antennal-lobe local
    neurons are GABAergic but predicted otherwise, and with the wrong sign
    the olfactory system falls into self-sustained seizure-like activity.

Sensory channels
    Each game observation drives one identified sensory (or visual projection
    / ascending) population, see CHANNELS below. Motor readout uses every
    descending neuron plus the brain's own motor neurons.

Usage
    ./fetch_flywire.sh raw
    python3 build_brain.py --raw raw --out ../brain
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

MIN_SYN = 3
FORMAT_VERSION = 1

# Game observation -> sensory population. The pairing is a design choice: each
# game signal goes to a population whose natural meaning for a fly fits it,
# among populations that actually reach the descending neurons within a
# decision window (see fly/train/calibrateBrain.ts). Olfactory, hygro- and
# thermosensory inputs were tried first; their signal fades in the antennal
# lobe / mushroom body before it reaches the motor side within 100 ms.
# The rationale strings are shown in the viewer.
CHANNELS = [
    {
        "key": "sugar",
        "label": "Sugar taste (GRNs)",
        "game": "Unclaimed land on our border",
        "why": "Sugar gustatory neurons drive feeding; in the whole-brain LIF model of Shiu et al. they activate the proboscis motor neuron MN9. Free land is food.",
        "filter": {"cell_sub_class": ["sugar/water"]},
    },
    {
        "key": "touch",
        "label": "Head bristles (touch)",
        "game": "Enemy troops attacking us, relative to our own",
        "why": "Bristle mechanoreceptors on the head report being touched; an attack is something pushing into the body.",
        "filter": {"cell_type": ["BM_Vib", "BM_Ant", "BM_vOcci_vPoOr", "BM_Fr"]},
    },
    {
        "key": "looming",
        "label": "Looming (LC4, LPLC2)",
        "game": "An attack big enough to break us",
        "why": "LC4 and LPLC2 visual projection neurons detect approaching objects and feed the giant-fiber escape pathway (DNp01).",
        "filter": {"cell_type": ["LC4", "LPLC2"]},
    },
    {
        "key": "pursuit",
        "label": "Small-object pursuit (LC10)",
        "game": "Our attack stack against the best target's army (log scale)",
        "why": "LC10 neurons track small moving objects; males use them to chase a courtship target.",
        "filter": {"cell_type_regex": "^LC10"},
        "max": 240,
    },
    {
        "key": "prey",
        "label": "Visual objects (LPLC4, LC11)",
        "game": "Weak bot tribes on our border",
        "why": "LPLC4 and LC11 respond to small or approaching objects in the visual field.",
        "filter": {"cell_type": ["LPLC4", "LC11"]},
    },
    {
        "key": "rival",
        "label": "Collision (LPLC1, LC22)",
        "game": "The strongest bordering rival, relative to us",
        "why": "LPLC1 mediates collision avoidance; a large neighbour is something to steer clear of.",
        "filter": {"cell_type": ["LPLC1", "LC22"]},
    },
    {
        "key": "wind",
        "label": "Wind (Johnston's organ C/E)",
        "game": "Coastline and targets reachable by boat",
        "why": "JO-C and JO-E neurons in the antenna sense wind and gravity; boats need wind.",
        "filter": {"cell_type_regex": "^JO-[CE]"},
    },
    {
        "key": "song",
        "label": "Hearing (Johnston's organ A/B)",
        "game": "Alliance requests from other players",
        "why": "JO-A and JO-B neurons hear courtship song; another player asking for an alliance is courting us.",
        "filter": {"cell_type_regex": "^JO-[AB]"},
    },
    {
        "key": "light",
        "label": "Ocelli (light level)",
        "game": "Game clock: how far the match has progressed",
        "why": "The three ocelli measure overall light; the day moves on as the match does.",
        "filter": {"cell_sub_class": ["ocellar"]},
    },
    {
        "key": "energy",
        "label": "Ascending: energy",
        "game": "Troops relative to our troop cap",
        "why": "Ascending neurons carry the body's state up from the ventral nerve cord.",
        "filter": {"cell_sub_class": ["AN_AVLP", "AN_AVLP_GNG", "AN_AVLP_PVLP"]},
    },
    {
        "key": "wealth",
        "label": "Ascending: gut",
        "game": "Gold relative to what a city costs",
        "why": "Ascending neurons into the gnathal ganglia relay feeding-related state.",
        "filter": {"cell_sub_class": ["AN_GNG_SAD", "AN_GNG_VES", "AN_VES_GNG", "AN_GNG_FLA", "AN_GNG_PRW"]},
    },
    {
        "key": "size",
        "label": "Ascending: body size",
        "game": "Our share of the map's land",
        "why": "Ascending neurons with multi-neuropil targets; a proxy for how big the body has grown.",
        "filter": {"cell_sub_class": ["AN_multi"]},
    },
    {
        "key": "strain",
        "label": "Ascending: effort",
        "game": "Share of our troops already out attacking",
        "why": "Ascending neurons to the posterior slope, where locomotor effort signals arrive.",
        "filter": {"cell_sub_class": ["AN_IPS_GNG", "AN_GNG_IPS", "AN_SPS_IPS", "AN_IPS_LAL"]},
    },
    {
        "key": "hoard",
        "label": "Ascending: reserves",
        "game": "Gold in the bank, on a log scale (100k to 100M)",
        "why": "Ascending neurons into the gnathal ganglia; a second, slower signal of stored energy.",
        "filter": {"cell_sub_class": ["AN_GNG"]},
        "max": 240,
    },
    {
        "key": "shore",
        "label": "Proboscis bristles",
        "game": "Coastline without enough ports",
        "why": "Mechanosensory bristles on the labellum, touched while foraging at the water's edge.",
        "filter": {"cell_type": ["BM_Taste"]},
    },
    {
        "key": "build",
        "label": "Visual (LC9)",
        "game": "Cities without enough factories and rail",
        "why": "LC9 visual projection neurons; the fly sees its own territory lacking infrastructure.",
        "filter": {"cell_type": ["LC9"]},
    },
    {
        "key": "sky",
        "label": "Visual (MTe01b)",
        "game": "Nuclear threat: rival missile silos or nukes in the air",
        "why": "MTe01b medulla tangential neurons; danger from above.",
        "filter": {"cell_type": ["MTe01b"]},
    },
]

SUPER_CLASSES = [
    "central",
    "sensory",
    "visual_projection",
    "ascending",
    "descending",
    "sensory_ascending",
    "visual_centrifugal",
    "motor",
    "endocrine",
    "optic",
]

NT_CODES = ["acetylcholine", "glutamate", "gaba", "dopamine", "serotonin", "octopamine", "histamine"]
INHIBITORY = {"gaba", "glutamate", "histamine"}


def transmitter(known: object, top: object) -> str:
    """First positively identified transmitter in known_nt, else top_nt."""
    if isinstance(known, str):
        for part in re.split(r"[;,]", known):
            t = part.strip()
            if t in NT_CODES:
                return t
    return top if isinstance(top, str) else ""


def is_simulated(ann: pd.DataFrame) -> pd.Series:
    photoreceptor = (ann.super_class == "sensory") & (ann.cell_class == "visual") & (
        ann.cell_sub_class != "ocellar"
    )
    return (ann.super_class != "optic") & ~photoreceptor


def match(ann: pd.DataFrame, flt: dict) -> pd.Series:
    mask = pd.Series(True, index=ann.index)
    for col, values in flt.items():
        if col == "cell_type_regex":
            mask &= ann.cell_type.fillna("").str.contains(values, regex=True)
        else:
            mask &= ann[col].isin(values)
    return mask


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=Path(__file__).parent / "raw")
    ap.add_argument("--out", type=Path, default=Path(__file__).parent.parent / "brain")
    ap.add_argument("--min-syn", type=int, default=MIN_SYN)
    args = ap.parse_args()

    ann = pd.read_csv(
        args.raw / "Supplemental_file1_neuron_annotations.tsv", sep="\t", low_memory=False
    )
    con = pd.read_parquet(
        args.raw / "Connectivity_783.parquet",
        columns=["Presynaptic_ID", "Postsynaptic_ID", "Connectivity", "Excitatory"],
    )

    ann["sim"] = is_simulated(ann)
    ann["sc"] = pd.Categorical(ann.super_class, categories=SUPER_CLASSES).codes
    # Simulated neurons first, grouped by super class, stable by root id.
    ann = ann.sort_values(["sim", "sc", "root_id"], ascending=[False, True, True]).reset_index(
        drop=True
    )
    n_all = len(ann)
    n_sim = int(ann.sim.sum())
    assert n_sim < 65536, n_sim
    idx_of = pd.Series(np.arange(n_all), index=ann.root_id.values)

    sim_ids = set(ann.root_id[ann.sim])
    c = con[
        con.Presynaptic_ID.isin(sim_ids)
        & con.Postsynaptic_ID.isin(sim_ids)
        & (con.Connectivity >= args.min_syn)
    ].copy()
    total_syn = con[con.Presynaptic_ID.isin(sim_ids) & con.Postsynaptic_ID.isin(sim_ids)].Connectivity.sum()
    c["pre"] = idx_of.loc[c.Presynaptic_ID].values
    c["post"] = idx_of.loc[c.Postsynaptic_ID].values
    ann["nt_used"] = [transmitter(k, t) for k, t in zip(ann.known_nt, ann.top_nt)]
    sign = pd.Series(
        np.where(ann.nt_used.isin(INHIBITORY), -1, np.where(ann.nt_used == "", 0, 1)),
        index=ann.root_id.values,
    )
    pre_sign = sign.loc[c.Presynaptic_ID].values
    # Fall back to the connectivity table's own sign when nothing is annotated.
    pre_sign = np.where(pre_sign == 0, np.sign(c.Excitatory.values), pre_sign)
    flipped = int((pre_sign != np.sign(c.Excitatory.values)).sum())
    print(f"  sign differs from Connectivity_783 'Excitatory' on {flipped} edges")
    c["w"] = np.clip(c.Connectivity.values, 0, 32767) * pre_sign
    c = c.sort_values(["pre", "post"])
    counts = np.bincount(c.pre.values, minlength=n_sim)
    rowptr = np.zeros(n_sim + 1, dtype=np.uint32)
    rowptr[1:] = np.cumsum(counts)
    col = c.post.values.astype(np.uint16)
    w = c.w.values.astype(np.int16)

    # Anchor points are in 4x4x40 nm voxels; store micrometres x 4 as int16.
    pos_um = np.stack(
        [ann.pos_x.values * 0.004, ann.pos_y.values * 0.004, ann.pos_z.values * 0.04], axis=1
    )
    center = np.nanmedian(pos_um, axis=0)
    pos_q = np.nan_to_num((pos_um - center) * 4.0).round().astype(np.int16)

    sc = ann.sc.values.astype(np.uint8)
    nt = pd.Categorical(ann.nt_used.replace("", np.nan), categories=NT_CODES).codes.astype(np.int16) + 1  # 0 = unknown
    nt = nt.astype(np.uint8)
    types = ann.cell_type.fillna("").astype(str)
    type_names = [""] + sorted(t for t in types.unique() if t)
    type_idx = pd.Series(np.arange(len(type_names)), index=type_names)
    tcode = type_idx.loc[types.values].values.astype(np.uint16)
    vfb = (
        ann.vfb_id.fillna("fw0").astype(str).str.replace("fw", "", regex=False).astype(np.int64).values
    ).astype(np.uint32)
    side = ann.side.map({"left": 1, "right": 2, "center": 3}).fillna(0).astype(np.uint8).values

    channels = []
    for ch in CHANNELS:
        m = match(ann, ch["filter"]) & ann.sim
        neurons = np.flatnonzero(m.values).astype(int)
        assert neurons.size, ch["key"]
        cap = ch.get("max")
        if cap is not None and neurons.size > cap:
            # Deterministic, evenly spread subsample across the population.
            neurons = neurons[np.linspace(0, neurons.size - 1, cap).round().astype(int)]
        neurons = neurons.tolist()
        channels.append(
            {k: ch[k] for k in ("key", "label", "game", "why")}
            | {"filter": ch["filter"], "neurons": neurons}
        )
        print(f"  channel {ch['key']:10s} {len(neurons):4d} neurons")

    readout = np.flatnonzero(
        ann.sim.values & ann.super_class.isin(["descending", "motor"]).values
    ).astype(int)
    # Named neurons worth pointing at in the viewer.
    landmarks = {}
    for name in ["DNp01", "MDN", "DNa01", "DNa02", "DNp09", "CB0701", "DNg12_a", "DNp42"]:
        landmarks[name] = np.flatnonzero((ann.cell_type == name).values & ann.sim.values).astype(int).tolist()

    sections = {}
    blob = bytearray()

    def add(name: str, arr: np.ndarray) -> None:
        while len(blob) % 8:
            blob.append(0)
        sections[name] = {"offset": len(blob), "length": int(arr.size), "dtype": str(arr.dtype)}
        blob.extend(arr.astype(arr.dtype.newbyteorder("<")).tobytes())

    add("pos", pos_q.reshape(-1))
    add("superClass", sc)
    add("nt", nt)
    add("cellType", tcode)
    add("vfb", vfb)
    add("side", side)
    add("rowptr", rowptr)
    add("col", col)
    add("weight", w)

    args.out.mkdir(parents=True, exist_ok=True)
    stem = "flywire783"
    # mtime=0 keeps the file byte-identical across rebuilds.
    with open(args.out / f"{stem}.bin.gz", "wb") as raw, gzip.GzipFile(
        fileobj=raw, mode="wb", compresslevel=9, mtime=0
    ) as f:
        f.write(bytes(blob))

    meta = {
        "format": FORMAT_VERSION,
        "name": "FlyWire 783 game brain",
        "source": {
            "connectome": "FlyWire FAFB v783 (Dorkenwald et al. 2024, Nature; Schlegel et al. 2024, Nature), CC-BY 4.0",
            "connectivity": "Connectivity_783.parquet from Shiu et al. 2024, Nature (github.com/philshiu/Drosophila_brain_model)",
            "annotations": "Supplemental_file1_neuron_annotations.tsv (github.com/flyconnectome/flywire_annotations)",
            "vfb": "vfb_id -> https://virtualflybrain.org/reports/<vfb_id>",
        },
        "nAll": n_all,
        "nSim": n_sim,
        "nEdges": int(col.size),
        "minSyn": args.min_syn,
        "synapsesKept": float(c.Connectivity.sum() / total_syn),
        "posScale": 0.25,
        "posCenterUm": center.tolist(),
        "superClasses": SUPER_CLASSES,
        "neurotransmitters": ["unknown"] + NT_CODES,
        "cellTypes": type_names,
        "sections": sections,
        "channels": channels,
        "readout": readout.tolist(),
        "landmarks": landmarks,
    }
    (args.out / f"{stem}.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(
        f"neurons {n_all} (simulated {n_sim}), edges {col.size} "
        f"({meta['synapsesKept']:.1%} of synapses), readout {readout.size}, "
        f"bin {len(blob) / 1e6:.1f} MB"
    )


if __name__ == "__main__":
    main()
