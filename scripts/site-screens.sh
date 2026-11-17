#!/usr/bin/env bash
# Copies the screenshots the project site shows from tmp/screens/ (written by
# `make e2e-screens`) into site/images/.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
names=(pods-drawer-light pods-drawer-dark catalog-light dock-yaml-light)
missing=()
for name in "${names[@]}"; do
  [ -f "tmp/screens/$name.png" ] || missing+=("tmp/screens/$name.png")
done
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'missing screenshot: %s\n' "${missing[@]}" >&2
  echo "run make e2e-screens first" >&2
  exit 1
fi
mkdir -p site/images
for name in "${names[@]}"; do
  cp "tmp/screens/$name.png" "site/images/$name.png"
done
echo "copied ${#names[@]} screenshots into site/images/"
