#!/usr/bin/env bash
# Release helper; the flow is in docs/releasing.md.
#   scripts/release.sh bump <version>   on a clean main: set the version, date the CHANGELOG's
#                                        Unreleased notes, commit, and make the annotated tag
#   scripts/release.sh check <tag>      the tag names the version in every file, sits on
#                                        origin/main and has notes; prints prerelease=true|false
#   scripts/release.sh notes <version>  print the CHANGELOG notes of a version
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SEMVER='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
JSON_FILES=(crates/skopos-app/tauri.conf.json package.json ui/package.json e2e/package.json)

die() {
  echo "release: $*" >&2
  exit 1
}

# One "<file> <version>" line for every place that holds the version.
versions() {
  echo "Cargo.toml $(sed -n '/^\[workspace\.package\]/,/^\[/s/^version = "\(.*\)"$/\1/p' Cargo.toml)"
  local f
  for f in "${JSON_FILES[@]}"; do
    echo "$f $(node -p "require('./$f').version")"
  done
  awk '/^name = "skopos-/ { name = $3 } /^version = / && name { print "Cargo.lock:" name " " $3; name = "" }' \
    Cargo.lock | tr -d '"'
}

# The lines under "## [<version>]" up to the next "## [" heading, without blank edges.
notes() {
  awk -v heading="## [$1]" '
    /^## \[/ { if (found) exit; found = index($0, heading) == 1; next }
    found { lines[++n] = $0 }
    END {
      first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
      while (n >= first && lines[n] ~ /^[[:space:]]*$/) n--
      for (i = first; i <= n; i++) print lines[i]
    }' CHANGELOG.md
}

wrong_versions() {
  versions | awk -v want="$1" '$2 != want'
}

check() {
  local tag=$1 version=${1#v} wrong
  [[ $tag == v* && $version =~ $SEMVER ]] || die "$tag is not v<semver>"
  wrong=$(wrong_versions "$version")
  [[ -z $wrong ]] || die "these files do not say $version:"$'\n'"$wrong"
  git merge-base --is-ancestor HEAD refs/remotes/origin/main ||
    die "$tag is not on origin/main: push main with the tag (git push --atomic origin main $tag)"
  [[ -n $(notes "$version") ]] || die "CHANGELOG.md has no notes under ## [$version]"
  if [[ $version == *-* ]]; then echo prerelease=true; else echo prerelease=false; fi
}

bump() {
  local version=$1 tag="v$1" wrong
  [[ $version =~ $SEMVER ]] || die "$version is not a semver version"
  [[ $(git symbolic-ref --short -q HEAD || true) == main ]] || die "check out main first"
  [[ -z $(git status --porcelain --untracked-files=no) ]] || die "commit or stash your changes first"
  ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "$tag already exists"
  [[ -n $(notes Unreleased) ]] || die "CHANGELOG.md has no notes under ## [Unreleased]"

  perl -0pi -e "s/^## \\[Unreleased\\]\\n/## [Unreleased]\\n\\n## [$version] - $(date -u +%F)\\n/m" CHANGELOG.md
  perl -0pi -e "s/(\\[workspace\\.package\\]\\n(?:[^\\[\\n][^\\n]*\\n)*?version = )\"[^\"]*\"/\${1}\"$version\"/" Cargo.toml
  perl -0pi -e "s/(name = \"skopos-[a-z-]+\"\\nversion = )\"[^\"]*\"/\${1}\"$version\"/g" Cargo.lock
  local f
  for f in "${JSON_FILES[@]}"; do
    perl -0pi -e "s/(\"version\":\\s*)\"[^\"]*\"/\${1}\"$version\"/" "$f"
  done
  wrong=$(wrong_versions "$version")
  [[ -z $wrong ]] || die "could not set $version in:"$'\n'"$wrong"

  git add CHANGELOG.md Cargo.toml Cargo.lock "${JSON_FILES[@]}"
  git commit -q -m "chore(release): $version"
  git tag -a "$tag" -m "SkoposIDE $tag"
  echo "Committed and tagged $tag. Publish it with:"
  echo "  git push --atomic origin main $tag"
}

case "${1:-}" in
bump | check | notes)
  [[ $# -eq 2 ]] || die "usage: $0 $1 <version>"
  "$1" "$2"
  ;;
*) die "usage: $0 bump <version> | check <tag> | notes <version>" ;;
esac
