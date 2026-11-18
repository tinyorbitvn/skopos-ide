# CI and releases

`main` is the only long-lived branch. Work lands on it directly or through a pull request.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request. Any branch
can also be run by hand from the Actions tab (Run workflow). A newer push to a pull request
cancels the older run.

| Job | Runners | What it runs |
| --- | --- | --- |
| `check` | Linux, macOS 15, Windows 2022 | `make check` |
| `linux-integration` | Linux | `make test-kind`, then `make e2e` on a kind cluster |
| `smoke` | macOS 15, Windows 2022 | `make e2e-smoke` against the fake cluster |

Hosted macOS runners cannot run the kind cluster, so the kind and full end-to-end suites run on
Linux only. The jobs share their toolchain and cache setup through `.github/actions/setup`.

## Cutting a release

1. Add notes under `## [Unreleased]` in `CHANGELOG.md` as changes land. The release refuses
   to start without them.
2. On a clean, up-to-date `main`:

   ```sh
   make release VERSION=0.7.0
   git push --atomic origin main v0.7.0
   ```

   `make release` (`scripts/release.sh bump`) sets the version in `Cargo.toml`, `Cargo.lock`,
   `tauri.conf.json` and the three `package.json` files. It dates the Unreleased notes as
   `## [0.7.0] - <date>`, commits `chore(release): 0.7.0` and makes the annotated tag. It pushes
   nothing.
3. The tag starts `.github/workflows/release.yml`:
   1. **verify:** the tag matches the version in every file, the tagged commit is on `main`, and
      `CHANGELOG.md` has notes for that version.
   2. **ci:** the whole CI runs on the tagged commit. Nothing is built if it fails.
   3. **draft:** a draft release is made with those notes.
   4. **build:** Linux, macOS arm64, macOS x64 and Windows builds are added to the draft. The
      macOS signature is checked inside the dmg.
   5. **publish:** once all four builds pass, the draft must hold the five installers (AppImage,
      deb, arm64 and x64 dmg, Windows setup exe); then it is published and marked Latest. A tag
      with a pre-release suffix, such as `v0.7.0-rc.1`, is published as a pre-release.

## When a release fails

- A flaky job: re-run the failed jobs from the run page. The draft and its finished uploads
  are kept, and the publish step runs once the builds pass.
- A real fix: commit it on `main`, then move the tag and start again:

  ```sh
  git push origin :refs/tags/v0.7.0 && git tag -d v0.7.0
  gh release delete v0.7.0 --yes   # only if a draft was made
  git tag -a v0.7.0 -m "SkoposIDE v0.7.0"
  git push --atomic origin main v0.7.0
  ```

  The version files and notes already say 0.7.0, so `make release` is not run again.

## Project site

The project site at https://vanlongme.github.io/skopos-ide/ is built from `site/` by
`scripts/build-site.mjs` and deployed by `.github/workflows/pages.yml`.

- A push to `main` that changes `site/`, the build script, the tokens, the icon or
  the workflow redeploys it, and so does Run workflow on the `pages` workflow.
- Every successful `release` run redeploys it. The version, dates, sizes and download links come
  from the latest published release, read with `gh api`, so a new release needs no edit. When an
  installer is missing from the release, the build stops and the live site stays as it was.
- When you cut a release, remove the `next-release` marks in `site/index.html` for what the
  release ships, and mark new features under `## [Unreleased]` that the page shows.
- `make site-screens` refreshes the screenshots in `site/images/` from the e2e `screens` spec
  (Docker, kind and the WebKit driver).
- `make site` builds the site into `tmp/site/` from the latest published release. Serve that
  folder over HTTP to look at it (`python3 -m http.server --directory tmp/site`), since browsers
  block fonts from `file://`.

The repository's Settings › Pages › Build and deployment › Source must be **GitHub Actions**.
