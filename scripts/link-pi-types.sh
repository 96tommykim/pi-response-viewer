#!/usr/bin/env bash
# Link Pi's globally installed type package for standalone extension typechecking.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
groot="$(npm root -g)"
pca="$groot/@earendil-works/pi-coding-agent"
[ -d "$pca" ] || {
  echo "error: @earendil-works/pi-coding-agent is not globally installed" >&2
  echo "       run: npm i -g @earendil-works/pi-coding-agent" >&2
  exit 1
}

mkdir -p "$root/node_modules/@earendil-works"
ln -sfn "$pca" "$root/node_modules/@earendil-works/pi-coding-agent"
echo "linked Pi types into $root/node_modules (source: $pca)"
