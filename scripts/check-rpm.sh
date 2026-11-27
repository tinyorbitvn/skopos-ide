#!/usr/bin/env bash
# Installs a built SkoposIDE rpm on the distributions it supports and checks that every library
# its binaries link resolves (docs/releasing.md, "RPM"). Fedora has WebKitGTK 4.1 and the tray
# library in its own repositories; RHEL 10 and its rebuilds take both from EPEL. RHEL 9 has no WebKitGTK 4.1 and an
# older glibc than the build's, so it is not supported. Needs Docker.
#
# usage: scripts/check-rpm.sh <SkoposIDE-x.y.z-1.x86_64.rpm>
set -euo pipefail

FEDORA_IMAGE="${FEDORA_IMAGE:-fedora:45}"
EL_IMAGE="${EL_IMAGE:-almalinux:10}"

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: scripts/check-rpm.sh <SkoposIDE-x.y.z-1.x86_64.rpm>" >&2
  exit 2
fi
dir="$(cd "$(dirname "$1")" && pwd)"
file="$(basename "$1")"

# Runs in the container: $1 is the rpm's path there.
inside='
set -euo pipefail
dnf install -y -q "$1" > /tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }
name="$(rpm -qp --queryformat "%{NAME}" "$1")"
rpm -q "$name"
bins="$(rpm -ql "$name" | grep "^/usr/bin/")"
[ -n "$bins" ] || { echo "$name installs nothing in /usr/bin"; exit 1; }
for bin in $bins; do
  missing="$(ldd "$bin" | grep "not found" || true)"
  if [ -n "$missing" ]; then
    echo "$bin links libraries that are not installed:"
    echo "$missing"
    exit 1
  fi
  echo "$bin: every library resolves"
done
'

check() {
  local image="$1" setup="$2"
  echo "== $image"
  docker run --rm -v "$dir:/rpm:ro" "$image" bash -c "$setup && bash -c '$inside' check /rpm/$file"
}

check "$FEDORA_IMAGE" "true"
check "$EL_IMAGE" "dnf install -y -q epel-release > /dev/null"
