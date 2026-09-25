#!/usr/bin/env bash
# One-time setup: fetch OpenFront at the pinned commit, apply the OpenFly
# hooks, install OpenFront's dependencies.
#
# OpenFront pins Node 24.x and npm 12.x and makes npm refuse anything else.
# OpenFly has also been checked on Node 26 (with its npm 11): install,
# tests, build, dev server and a fly game all work. On a version outside the
# pin we warn and install anyway; set OPENFLY_STRICT_ENGINES=1 to refuse.
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

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NPM_MAJOR="$(npm -v | cut -d. -f1)"
ENGINE_FLAGS=()
if [ "$NODE_MAJOR" != "24" ] || [ "$NPM_MAJOR" != "12" ]; then
  if [ "${OPENFLY_STRICT_ENGINES:-0}" = "1" ]; then
    echo "OpenFront wants Node 24 and npm 12; found Node $(node -v), npm $(npm -v)." >&2
    exit 1
  fi
  echo "Note: OpenFront pins Node 24.x / npm 12.x, you have Node $(node -v) / npm $(npm -v)."
  echo "      Installing anyway (--engine-strict=false). If something breaks, use Node 24"
  echo "      (e.g. 'nvm install 24 && npm i -g npm@12') and run this script again."
  ENGINE_FLAGS=(--engine-strict=false)
fi

npm ci --ignore-scripts ${ENGINE_FLAGS[@]+"${ENGINE_FLAGS[@]}"}
cd "$ROOT"
# Lets files under fly/ resolve OpenFront's packages (zod, vite types, tsx).
ln -sfn openfront/node_modules node_modules
echo
echo "Done. Start the game with:  npm run dev   (then Solo -> '🪰 Let the fly play')"
