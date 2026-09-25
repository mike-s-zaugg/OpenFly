#!/usr/bin/env bash
# One-time setup: fetch OpenFront at the pinned commit, apply the OpenFly
# hooks, install OpenFront's dependencies.
#
# Needs Node >= 24.15 and npm >= 12.1 (OpenFront's own requirement).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git submodule update --init --depth 1 openfront

cd openfront
PATCH="$ROOT/patches/openfront.patch"
if git apply --check "$PATCH" 2>/dev/null; then
  git apply "$PATCH"
  echo "OpenFly hooks applied to openfront/"
elif git apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "OpenFly hooks already applied"
else
  echo "patches/openfront.patch does not apply to this OpenFront checkout." >&2
  echo "Is the submodule at the pinned commit? (git submodule status)" >&2
  exit 1
fi

npm ci --ignore-scripts
cd "$ROOT"
# Lets files under fly/ resolve OpenFront's packages (zod, vite types, tsx).
ln -sfn openfront/node_modules node_modules
echo
echo "Done. Start the game with:  npm run dev   (then Single Player -> 'Let the fly play')"
