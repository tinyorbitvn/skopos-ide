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
| `sbom` | Linux | `make sbom`; the SBOM is kept as the run's `sbom` artifact |

Hosted macOS runners cannot run the kind cluster, so the kind and full end-to-end suites run on
Linux only. The jobs share their toolchain and cache setup through `.github/actions/setup`.

`.github/workflows/dependency-review.yml` runs on the same pushes and pull requests and checks
the dependency advisories each change adds; see
[Dependencies and advisories](#dependencies-and-advisories).

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
   4. **build:** Linux, macOS arm64, macOS x64 and Windows builds are added to the draft. Each
      macOS build is signed with the Developer ID certificate and notarized by Apple: Tauri
      signs, notarizes and staples the app and signs the dmg, then `scripts/macos-trust.mjs`
      notarizes and staples the dmg, checks the dmg, the app inside it and the app in the
      updater archive, and replaces the dmg in the draft (see
      [macOS signing and notarization](#macos-signing-and-notarization)). Each build signs its
      updater files with the updater key: the AppImage, the deb and the Windows setup exe get a
      `.sig`, and each macOS build adds `SkoposIDE_aarch64.app.tar.gz` or
      `SkoposIDE_x64.app.tar.gz` and its `.sig`. A build stops at once when the updater key's
      secret, or on macOS an Apple secret, is not set.
   5. **sbom:** once the draft exists, `make sbom` builds the SBOM and uploads it to the draft as
      `SkoposIDE_<version>.cdx.json` (see [SBOM](#sbom)).
   6. **publish:** once all four builds and the SBOM pass, `scripts/updater-manifest.mjs` builds
      `latest.json` from the draft's updater files and signatures and uploads it to the draft.
      The draft must then hold the five installers (AppImage, deb, arm64 and x64 dmg, Windows
      setup exe), the updater files, `latest.json` and the SBOM; then it is published and marked
      Latest.
      A tag with a pre-release suffix, such as `v0.7.0-rc.1`, is published as a pre-release,
      which installed copies are not offered. For a stable release, the job then checks that
      `releases/latest/download/latest.json` offers the new version and that each of its
      downloads answers.

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

## The updater key

Installed copies install only an update signed with the updater key.

- The maintainer made the key with `pnpm tauri signer generate -w ~/.tauri/skopos-updater.key`
  and keeps the key file and its password in a password manager. Nobody else handles them, and
  they are never committed.
- The repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file's content) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` hold them for the release builds.
- The public half is `crates/skopos-app/updater.key.pub`, and the same line is `pubkey` in
  `crates/skopos-app/tauri.conf.json`. A test checks that they match.
- If the key is lost, installed copies cannot update any more. A release signed with a new key
  must then be installed by hand.
- Only the release build makes updater files (`--config crates/skopos-app/tauri.updater.conf.json`),
  so CI, e2e and local builds need no key.

## macOS signing and notarization

Release builds for macOS are signed with the maintainer's Developer ID Application certificate
and notarized by Apple, so Gatekeeper opens them without Open Anyway or `xattr`. Local, CI and
e2e builds keep the ad-hoc signature (`"signingIdentity": "-"` in `tauri.conf.json`); only the
release build sets `APPLE_SIGNING_IDENTITY`. The app needs no entitlements.

- The values live in the repository environment `release`, which only `v*` tags may use
  (Settings › Environments › release › Deployment branches and tags). The build job names it.

  | Name | Kind | Content |
  | --- | --- | --- |
  | `APPLE_CERTIFICATE` | secret | base64 of the exported Developer ID Application `.p12` |
  | `APPLE_CERTIFICATE_PASSWORD` | secret | the `.p12` export password |
  | `APPLE_API_ISSUER` | secret | App Store Connect issuer ID |
  | `APPLE_API_KEY` | secret | App Store Connect key ID |
  | `APPLE_API_PRIVATE_KEY` | secret | the text of `AuthKey_<key id>.p8` |
  | `APPLE_ID`, `APPLE_PASSWORD` | secret | instead of the API key: the Apple ID and an app-specific password |
  | `APPLE_TEAM_ID` | variable | the Team ID |
  | `APPLE_SIGNING_IDENTITY` | variable | `Developer ID Application: <name> (<Team ID>)` |

- The maintainer keeps the `.p12`, its password and the `.p8` in a password manager. Nobody
  else handles them, and they are never committed.
- "The Apple signing secrets are set" stops a macOS build when a value is missing, and passes
  the values to the later steps of the macOS builds only. The build's last step, which runs even
  after a failure, deletes the `.p8` and empties those values, so the post-steps of the setup
  actions never see them.
- "Check the macOS files" fails the build unless the dmg and both copies of the app (the one in
  the dmg and the one the updater installs):
  - are signed with Developer ID and the team's ID;
  - carry a stapled ticket;
  - pass Gatekeeper as `Notarized Developer ID`.

  Both copies of the app must also use the hardened runtime with a secure timestamp and no
  entitlements.

  To check a downloaded release on a Mac:

  ```sh
  node scripts/macos-trust.mjs check --dmg SkoposIDE_<version>_aarch64.dmg \
    --updater SkoposIDE_aarch64.app.tar.gz --team <Team ID>
  ```

  On a Mac the check never changes the Gatekeeper setting: with assessments off, its first check
  fails and says how to turn them on. Only in GitHub Actions does it turn them on itself.

- When Apple rejects a submission, the step prints Apple's log. Fix the cause on `main` and
  move the tag (see [When a release fails](#when-a-release-fails)). When Apple is slow, the
  notarize step stops after 45 minutes; re-run the failed jobs.
- After a change to signing or notarization, cut the next version as a pre-release
  (`vX.Y.Z-rc.1`) first, and open its dmg on a Mac before the stable release.
- Before the certificate expires (the date is in the developer account), make a new Developer
  ID Application certificate and replace `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD`.
  Renew the Apple Developer Program membership every year. Revoke the certificate only if it
  leaks: revoking it affects the releases signed with it.

## Testing an update by hand

Do this for the first release that includes the updater, and again whenever the updater or the
release workflow changes.

1. Install the release by hand on macOS (arm64, and x64 where possible), Windows, the AppImage
   and the deb.
2. Publish the next release.
3. In each copy, choose Help > Check for Updates…, then Install and Restart. Check that the app
   restarts into the new version with its windows and tabs as they were.
4. On macOS, check that no Gatekeeper prompt appears. The first update from an ad-hoc signed
   release to a Developer ID signed one may ask once for the passwords SkoposIDE keeps in the
   Keychain; later updates must not ask.
5. On the deb, check that cancelling the password prompt shows "The package was not installed.
   If you cancelled the password prompt, try again." and that Try Again works.

## SBOM

Each release carries `SkoposIDE_<version>.cdx.json`, a CycloneDX 1.6 software bill of materials
of what the installers ship:

- The crates compiled into `skopos-app` for the four release targets, from `cargo cyclonedx`, one
  run per target. Each crate has a `skopos:target` property for every target that compiles it.
  Build dependencies are listed with `scope: "excluded"`, since they do not ship.
  `cargo cyclonedx` reads `cargo metadata`, which turns features on across the whole workspace
  and for build scripts too, so the list also holds a few crates the app does not link (15 at
  0.12.1, such as `httpdate` and `swift-rs`). No crate the app links is missing.
- The npm packages in the UI's `dependencies`, from `pnpm list --prod`, with their license, the
  lock file's SHA-512 and the registry tarball.

Dev dependencies, the `e2e` package, `skopos-fakekube` and the GitHub Actions are left out.
`scripts/sbom.mjs` joins the parts and refuses a BOM whose dependencies name a missing component.

To build it locally, install the pinned cargo-cyclonedx (`CARGO_CYCLONEDX_VERSION` in the
`Makefile`) and run `make sbom`:

```sh
cargo install --locked cargo-cyclonedx@0.5.10
make sbom   # writes tmp/sbom/SkoposIDE.cdx.json
```

CI's `sbom` job builds it on every push and pull request, so a broken generator stops a release
before the draft. To move to another cargo-cyclonedx, change the `Makefile` and both workflows
together; `scripts/sbom-workflow.test.mjs` checks that they match.

## Dependencies and advisories

Dependabot watches `Cargo.lock` and `pnpm-lock.yaml` against GitHub's advisory database. The
repository's security settings have Dependabot alerts and Dependabot security updates turned on.
It raises an alert when an advisory is published for a version the lock files hold, so no scan
runs on a schedule.

- **The policy:** a Rust advisory of any severity is fixed or accepted, and so is any other at
  high or critical. Low and moderate advisories in npm packages are warnings. An advisory with
  no severity counts as critical.
- **Fixing:** merge the security update pull request Dependabot opens. When it cannot lift an npm
  package that another package pins, add an override to `pnpm-workspace.yaml` with a comment that
  names the advisory, as for dompurify, glob and minimatch. For a crate, run
  `cargo update -p <crate> --precise <fixed version>`, which also lifts what the fixed version
  needs, or lift the dependency that holds it back.
- **Accepting:** when an advisory does not affect SkoposIDE or has no fix yet, dismiss the alert on
  the Security tab with the reason that fits (Tolerable risk, Not used, Inaccurate) and a comment
  that says why. The glib alert is one: glib 0.18 comes through Tauri's GTK 3 stack on Linux, and
  the fix is in 0.20. Nothing is recorded in the repository.
- **Each change:** the `dependency-review` workflow asks GitHub's dependency graph what a pull
  request or a push to `main` changes (`dependency-graph/compare`) and runs
  `scripts/advisories.mjs review`. It fails when the change brings in an advisory the policy does
  not allow and warns about the others, in the log and the job summary. An advisory the base
  already has does not count, so lifting a package with an accepted advisory passes. When the
  comparison fails three times, the job fails; re-run it.
- **Locally:** `make audit` lists the open Dependabot alerts with `gh` and fails when one breaks
  the policy. It needs `gh auth login`.
- **What Dependabot misses:** it reads only GitHub's advisory database, which gets RustSec
  advisories late or not at all, and has no notices for unmaintained crates. In November 2026
  neither RUSTSEC-2026-0592 (`url`) nor RUSTSEC-2026-0594 (`cookie`) was there. When lifting
  crates, also check https://rustsec.org/advisories/.

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
- `make site-screens` refreshes the site's pictures (`site/images/canvas-*.png`) from the
  main board of the SkoposIDE Screens design canvas, App.dc.html ("Whole application"). It
  renders the board in headless Chrome or Chromium (set `CHROME` if it is not on `PATH`), clicks
  through it and cuts each picture out; `scripts/canvas-screens.mjs` lists the shots. The board
  loads Google Fonts, so it needs the network. First save the canvas files under `tmp/canvas/` at
  their published paths, for example with the Artifact tool's `read` and `paths` in Claude Code:
  `project/App.dc.html`, the `project/ds/…` files the board's head names,
  `artifact-type/dc-runtime.js` (the board's `./support.js`) and, for each `/_blob/<id>` script
  the board loads, the asset saved as `_blob/<id>.js`. The script names any file still missing.
- Every `.html` file under `site/` is a page template with the same placeholders, such as
  `site/docs/metrics.html`, the metrics setup page. Keep it in step with the metrics settings and
  queries in `crates/skopos-core/src/metrics/` and `ui/src/features/settings/`.
- `make site` builds the site into `tmp/site/` from the latest published release. Serve that
  folder over HTTP to look at it (`python3 -m http.server --directory tmp/site`), since browsers
  block fonts from `file://`.

The repository's Settings › Pages › Build and deployment › Source must be **GitHub Actions**.
