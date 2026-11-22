//! Stands in for the app binary in the sandbox tests (R1): it runs the hidden agent modes. The app
//! bundles only `skopos-app`'s binary, so this one never ships.

fn main() {
    std::process::exit(skopos_core::agents::modes::run(std::env::args_os()).unwrap_or(2))
}
