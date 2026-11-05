# Sextant

Source-available desktop Kubernetes IDE built with Tauri 2, a Rust core and React.

## Develop

```sh
pnpm install
make dev     # run the app with hot reload
make check   # fmt, clippy, tests, TypeScript checks, provenance
```

## License

PolyForm Shield 1.0.0, source-available, not open source. Copyright Nguyen Van Long.

## Unsigned builds

Release builds are unsigned for now. On macOS, right-click the app and choose
Open, or run `xattr -dr com.apple.quarantine Sextant.app`. On Windows, choose
"More info" then "Run anyway" in SmartScreen. On Linux, mark the AppImage
executable with `chmod +x` and run it.
