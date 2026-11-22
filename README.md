# SkoposIDE

SkoposIDE is a source-available desktop Kubernetes IDE built with Tauri 2, a
Rust core and a React UI, free to use for people and companies alike. It reads
your kubeconfig files, connects to several clusters at once and lets you switch
between them from a hotbar.

Project site, with downloads for Linux, macOS and Windows:
https://vanlongme.github.io/skopos-ide/

## Status

Phase 3 (kinds). SkoposIDE is not yet feature complete: today it provides
the app shell, the cluster catalog, the hotbar, cluster connections, live resource
tables with a detail drawer, and a YAML editor for editing and creating objects.
Each kind now has its own columns, status badges, detail panels and actions,
including node drain and ConfigMap and Secret editing. Logs, shells and
port-forward come next. See
[docs/roadmap.md](docs/roadmap.md) for what comes next.

## Prerequisites

All platforms: Rust (stable), Node.js 22, pnpm.

- **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
  librsvg2-dev libsoup-3.0-dev patchelf`, plus `xvfb` for end-to-end tests.
- **macOS**: Xcode command line tools (`xcode-select --install`).
- **Windows**: Microsoft C++ Build Tools, WebView2 (included in Windows 11) and
  Git Bash, which provides the shell for `make` targets.

Integration tests also need Docker and [kind](https://kind.sigs.k8s.io/).

## Develop

```sh
pnpm install
make dev        # run the app with hot reload
make check      # fmt, clippy, Rust and UI tests, type checks, provenance
make test-kind  # integration tests against a kind cluster (needs Docker)
make e2e        # end-to-end tests (needs Docker and kind)
make e2e-smoke  # smoke end-to-end tests, no Docker
```

## Repository layout

- `crates/` Rust workspace: `skopos-core` (no Tauri dependency),
  `skopos-app` (the Tauri shell) and `skopos-fakekube` (a fake API server
  for tests).
- `ui/` React front end.
- `e2e/` WebdriverIO end-to-end specs and helpers.
- `scripts/` helper scripts (kind setup, provenance check, project site build).
- `site/` the project site, deployed to GitHub Pages (see `docs/releasing.md`).
- `docs/` roadmap, specs and plans.

## Unsigned builds

Release builds are unsigned for now.

- **macOS**: builds carry an ad-hoc signature, not one from Apple. Drag the app to Applications and open it. When macOS blocks it, go to System Settings > Privacy & Security and choose Open Anyway, or run `xattr -cr /Applications/SkoposIDE.app`.
- **Windows**: in SmartScreen choose "More info", then "Run anyway".
- **Linux**: mark the AppImage executable with `chmod +x` and run it.

## Updates

SkoposIDE asks github.com for `latest.json` of the newest release 10 seconds after it starts
and every 6 hours. Preferences > Updates turns this off, and Check for Updates… in the Help
menu asks at once. When a newer release is out, a toast and a button in the status bar offer
it. The update dialog shows the release notes; Install and Restart downloads the update,
checks its signature, installs it and restarts SkoposIDE with its windows and tabs.

- **macOS**: the app must be in Applications. A copy run from the disk image can't update
  itself. After an update, macOS may ask again for the passwords SkoposIDE keeps in the
  Keychain, because each build has its own ad-hoc signature; choose Always Allow.
- **Windows**: the installer closes SkoposIDE, installs the update and starts it. If the
  installer fails after SkoposIDE has closed, start SkoposIDE again: the old version is still
  installed.
- **Linux**: the AppImage replaces itself. The deb asks for your password to install the
  package. Other packages can't update themselves.

## License

SkoposIDE is source-available under the [PolyForm Shield License 1.0.0](LICENSE), not open
source. Copyright Nguyen Van Long. Anyone, people and companies alike, may use it free of
charge, change it and share it, but not to provide a product that competes with SkoposIDE or
with a product its licensor provides using it. [LICENSE](LICENSE) has the exact terms.

Third-party code, icons and packages keep their own licenses; their credits and license texts
are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
