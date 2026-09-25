#!/usr/bin/env bash
# Downloads the public FlyWire (release 783) data used to build the fly brain.
#
#   Connectivity_783.parquet / Completeness_783.csv
#       from Shiu et al. 2024 (Nature), github.com/philshiu/Drosophila_brain_model
#   Supplemental_file1_neuron_annotations.tsv
#       from Schlegel et al. 2024 (Nature), github.com/flyconnectome/flywire_annotations
#
# The annotation table also carries the Virtual Fly Brain ids (vfb_id, fbbt_id)
# that the brain viewer links to.
set -euo pipefail

DEST="${1:-$(dirname "$0")/raw}"
mkdir -p "$DEST"
cd "$DEST"

if [ ! -f Connectivity_783.parquet ]; then
  git clone --depth 1 https://github.com/philshiu/Drosophila_brain_model shiu
  cp shiu/Connectivity_783.parquet shiu/Completeness_783.csv .
  rm -rf shiu
fi

if [ ! -f Supplemental_file1_neuron_annotations.tsv ]; then
  git clone --depth 1 https://github.com/flyconnectome/flywire_annotations fwa
  cp fwa/supplemental_files/Supplemental_file1_neuron_annotations.tsv .
  rm -rf fwa
fi

ls -la
