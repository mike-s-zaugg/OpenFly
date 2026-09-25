#!/usr/bin/env bash
# Regenerates patches/openfront.patch from the edits in openfront/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/openfront"
git diff > "$ROOT/patches/openfront.patch"
git diff --stat
