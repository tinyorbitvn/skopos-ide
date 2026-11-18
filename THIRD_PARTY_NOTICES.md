# Third-party notices

SkoposIDE is new code, written for this project. Parts of its logic are adapted from the
open-source projects below, whose license requires this notice to stay with the code. The app
also bundles fonts, icons, npm packages and Rust crates. Their sections below give the copyright
notices that their licenses ask every copy to keep, and [License texts](#license-texts) gives
each license's text once.

## Freelens

- Source: https://github.com/freelensapp/freelens
- Reference commit: `3f2b73426bab36e68c31bb2c403e815187148ad7`
- License: MIT

Copyright (c) 2024-2026 Freelens Authors.

Copyright (c) 2022 OpenLens Authors.

The MIT License text is under [License texts](#license-texts).

## Kubernetes

Status strings and the drain behaviour follow `kubectl`, part of the Kubernetes project
(https://github.com/kubernetes/kubernetes and https://github.com/kubernetes/kubectl).
Copyright The Kubernetes Authors. Licensed under Apache-2.0, the license in `LICENSE`.

## Argo CD

- Source: https://github.com/argoproj/argo-cd
- Reference tag: `v3.6.1`, commit `94037c4d4e1af4bd0651d37a179fbd9e347e668c`
- License: Apache-2.0, the license in `LICENSE`. Copyright 2017-2018 The Argo Authors. The
  project has no NOTICE file.

The Argo CD actions write an Application the way the Argo CD API server does
(`server/application/application.go` and `util/argo/argo.go`). The tests install its CRDs and
`manifests/core-install.yaml` from that commit.

## Kubernetes Icons Set

- Source: https://github.com/kubernetes/community, `icons/svg/resources/unlabeled/`
- Reference commit: `a222663ef579405457f78f9fe3c077894565a918`
- License: Apache-2.0, the license in `LICENSE`, chosen of the two the set offers (Apache-2.0
  and CC-BY-4.0). Copyright The Kubernetes Authors.

The resource map draws 19 of these icons (`pod`, `deploy`, `rs`, `sts`, `ds`, `job`,
`cronjob`, `svc`, `ing`, `cm`, `secret`, `sa`, `pvc`, `ns`, `crd`, `role`, `rb`, `c-role`,
`crb`). `ui/scripts/packK8sIcons.mjs` packs them into path data in
`ui/src/features/map/icons/k8sIcons.ts` and leaves their shapes and colours unchanged. The
Gateway, HTTPRoute and GatewayClass icons put a Lucide glyph in the frame of the set's Ingress
icon; see [npm packages](#npm-packages).

The Kubernetes logo is a registered trademark of The Linux Foundation; its use here does not
imply endorsement by The Linux Foundation or the CNCF.

## Reading the reference locally

Reference code is not part of this repository. Clone it into `tmp/reference/`, which git
ignores, at the commit above. Delete its agent instruction files, so tools do not load them
as instructions for this project:

```sh
git init tmp/reference/freelens
cd tmp/reference/freelens
git fetch --depth 1 https://github.com/freelensapp/freelens 3f2b73426bab36e68c31bb2c403e815187148ad7
git checkout FETCH_HEAD
rm -rf .claude AGENTS.md CLAUDE.md
```

Argo CD is cloned the same way, sparse, with only the parts this project reads:

```sh
git init tmp/reference/argo-cd
cd tmp/reference/argo-cd
git fetch --depth 1 --filter=blob:none https://github.com/argoproj/argo-cd 94037c4d4e1af4bd0651d37a179fbd9e347e668c
git sparse-checkout set --no-cone /LICENSE /server/application/ /util/argo/ \
  /pkg/apis/application/v1alpha1/ /manifests/core-install.yaml /manifests/crds/ /docs/user-guide/ \
  /docs/operator-manual/core.md /docs/operator-manual/declarative-setup.md \
  /controller/appcontroller.go /controller/sync.go /common/common.go
git checkout FETCH_HEAD
rm -rf .claude AGENTS.md CLAUDE.md
```

Read this code only. Do not install, build or run it.

## Fonts

SkoposIDE bundles these fonts, unmodified, from their Fontsource packages. Both are under
the SIL Open Font License 1.1, whose text is under [License texts](#license-texts).

- **Manrope** (`@fontsource/manrope` 5.3): Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)
- **JetBrains Mono** (`@fontsource/jetbrains-mono` 5.3): Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

## npm packages

The interface (`ui/`) bundles the npm packages below: the production dependencies that
`pnpm -C ui licenses list --prod` reports, less type declarations, which do not ship. Each line
gives the copyright notice the package states, under its license; the texts are in
[License texts](#license-texts). Where a package offers MIT or Apache-2.0, SkoposIDE takes MIT.

MIT:

- `@radix-ui/*`: Copyright (c) 2022 WorkOS
- `@animateicons/react`: Copyright (c) 2025 Avijit Dey; the `motion` library it bundles:
  Copyright (c) 2024 Motion B.V. Its icons are Lucide's shapes (see `lucide-react` under ISC),
  some of them derived from Feather (see below).
- `@dnd-kit/*`: Copyright (c) 2021, Claudéric Demers
- `@floating-ui/*`: Copyright (c) 2021-present Floating UI contributors
- `@remix-run/route-pattern`: Copyright (c) 2025 Shopify Inc.
- `@tanstack/react-virtual`, `@tanstack/virtual-core`: Copyright (c) 2021-present Tanner Linsley
- `@tauri-apps/api`: Copyright (c) 2017 - Present Tauri Apps Contributors; Copyright 2019-2025,
  The Tauri Programme in the Commons Conservancy
- `@tauri-apps/plugin-clipboard-manager`, `@tauri-apps/plugin-dialog`: Copyright 2019-2022, The
  Tauri Programme in the Commons Conservancy
- `@xterm/xterm`, `@xterm/addon-fit`: Copyright (c) 2017-2019, The xterm.js authors; Copyright
  (c) 2014-2016, SourceLair Private Company; Copyright (c) 2012-2013, Christopher Jeffrey
- `aria-hidden`, `react-remove-scroll`, `react-remove-scroll-bar`, `react-style-singleton`,
  `use-callback-ref`, `use-sidecar`: Copyright (c) 2017 Anton Korzunov
- `get-nonce`: Copyright (c) 2020 Anton Korzunov
- `cookie-es`: Copyright (c) Pooya Parsa; Copyright (c) 2012-2014 Roman Shtylman; Copyright (c)
  2015 Douglas Christopher Wilson; Copyright (c) 2015 Nathan Friedly
- `detect-node-es`: Copyright (c) 2017 Ilya Kantor
- `lucide-react`, and the Lucide shapes of `@animateicons/react`, for the icons they derive from
  Feather: Copyright (c) 2013-present Cole Bemis
- `marked`, and its copy inside `monaco-editor`: Copyright (c) 2018+, MarkedJS; Copyright (c)
  2011-2018, Christopher Jeffrey
- `monaco-editor`: Copyright (c) 2016 - present Microsoft Corporation; its Node.js path
  library: Copyright Joyent, Inc. and other Node contributors
- `react`, `react-dom`, `scheduler`: Copyright (c) Meta Platforms, Inc. and affiliates.
- `react-router`: Copyright (c) React Training LLC 2015-2019; Copyright (c) Remix Software Inc.
  2020-2021; Copyright (c) Shopify Inc. 2022-2023
- `zustand`: Copyright (c) 2019 Paul Henschel

ISC:

- `lucide-react`: Copyright (c) 2026 Lucide Icons and Contributors. The app's icons are Lucide's
  shapes, animated by `@animateicons/react` or drawn by `lucide-react`, and the resource map's
  Gateway, HTTPRoute and GatewayClass icons put a Lucide glyph in the frame of the Kubernetes
  Ingress icon.
- `yaml`: Copyright Eemeli Aro

Apache-2.0, the license in `LICENSE`:

- DOMPurify, inside `monaco-editor` (Apache-2.0, chosen of Apache-2.0 and MPL-2.0): Copyright
  (c) Cure53 and other contributors

Markdown license:

- Markdown, whose license `marked` carries: Copyright © 2004, John Gruber. All rights reserved.

## Rust crates

The app's binary links `skopos-app`, `skopos-core` and the crates below: the dependencies that
`cargo tree -p skopos-app -e normal --target <triple>` lists for the four release targets
(`x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, `x86_64-apple-darwin` and
`x86_64-pc-windows-msvc`), procedural macros included, at the versions pinned in `Cargo.lock`.
Each line gives the copyright notices that the crate's license files state or, where they state
none, its authors from `Cargo.toml`. Where a crate offers MIT, SkoposIDE takes MIT; between
Apache-2.0 and a BSD license, it takes Apache-2.0. No crate ships an Apache-2.0 NOTICE file.
Run that command again when the dependencies change.

MIT:

- `adler2`: Authors: Jonas Schievink, oyvindln
- `aes`: Copyright (c) 2018-2024 The RustCrypto Project Developers; Copyright (c) 2018 Artyom
  Pavlov
- `ahash`: Copyright (c) 2018 Tom Kaitchuck
- `aho-corasick`, `byteorder`, `byteorder-lite`, `encoding_rs_io`, `jiff`, `jiff-core`, `memchr`,
  `termcolor`, `ucd-trie`, `walkdir`: Copyright (c) 2015 Andrew Gallant
- `allocator-api2`: Author: Zakarum
- `annotate-snippets`, `anstyle`, `serde_spanned`, `toml`, `toml_datetime` 1.1.2+spec-1.1.0,
  `toml_edit`, `toml_parser`, `toml_writer`: Copyright (c) Individual contributors
- `anyhow`, `async-trait`, `dtoa`, `dyn-clone`, `erased-serde`, `itoa`, `quote`, `semver`,
  `serde-untagged`, `serde_repr`, `syn`, `thiserror`, `thiserror-impl`, `typeid`, `unicode-ident`,
  `unsafe-libyaml`, `zmij`: Author: David Tolnay
- `apple-native-keyring-store`, `keyring`, `keyring-core`, `windows-native-keyring-store`,
  `zbus-secret-service-keyring-store`: Copyright (c) 2016 keyring Developers
- `arboard`: Copyright (c) 2022 The Arboard contributors
- `arraydeque`: Copyright (c) 2018 Andy Lok
- `async-broadcast`: Copyright (c) 2020 Yoshua Wuyts
- `async-channel`, `async-io`, `async-lock`, `async-process`, `async-task`, `fastrand`: Author:
  Stjepan Glavina
- `async-compression`, `compression-codecs`, `compression-core`: Copyright (c) 2018 the rustasync
  developers
- `async-executor`, `event-listener`, `piper`, `polling`: Authors: Stjepan Glavina, John Nunley
- `async-recursion`: Author: Robert Usher
- `async-signal`, `event-listener-strategy`: Author: John Nunley
- `async-stream`, `async-stream-impl`: Copyright (c) 2019 Carl Lerche; Copyright (c) 2018 David
  Tolnay
- `atk`, `cairo-rs`, `gdk`, `gdk-pixbuf`, `gdkx11`, `gio`, `glib`, `glib-macros`, `gtk`,
  `gtk3-macros`, `pango`: Copyrights in the gtk-rs Project project are retained by their
  contributors.
- `atk-sys`, `cairo-sys-rs`, `gdk-pixbuf-sys`, `gdk-sys`, `gdkwayland-sys`, `gdkx11-sys`,
  `gio-sys`, `glib-sys`, `gobject-sys`, `gtk-sys`, `pango-sys`: Author: The gtk-rs Project
  Developers
- `atomic-waker`, `futures-lite`: Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio
  Authors; Authors: Stjepan Glavina, Contributors to futures-rs
- `base64` 0.22.1: Copyright (c) 2015 Alice Maz
- `base64` 0.23.1: Copyright (c) 2025 Alice Maz, Marshall Pierce
- `bit-set`, `bit-vec`: Copyright (c) 2023 The Rust Project Developers
- `bitflags`, `glob`, `log`, `num`, `num-bigint`, `num-complex`, `num-integer`, `num-iter`,
  `num-rational`, `num-traits`, `regex`, `regex-automata`, `regex-syntax`: Copyright (c) 2014 The
  Rust Project Developers
- `block-buffer` 0.10.4: Copyright (c) 2018-2019 The RustCrypto Project Developers
- `block-buffer` 0.12.1, `block-padding`: Copyright (c) 2018-2025 The RustCrypto Project
  Developers
- `block2`, `objc2`, `objc2-encode`, `objc2-exception-helper`: Author: Mads Marquart
- `brotli`: Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors.
- `bytemuck`: Copyright (c) 2019 Daniel "Lokathor" Gee.
- `bytes`: Copyright (c) 2018 Carl Lerche
- `camino`: Authors: Without Boats, Ashley Williams, Steve Klabnik, Rain
- `cargo_metadata`: Author: Oliver Schneider
- `cbc`: Copyright (c) 2018-2022 RustCrypto Developers; Copyright (c) 2018 Artyom Pavlov
- `cfb`: Copyright (c) 2017 Matthew D. Steele
- `cfg-if`, `filetime`, `openssl-probe`, `socket2`, `stacker`, `toml_datetime` 0.6.3: Copyright
  (c) 2014 Alex Crichton
- `chacha20`, `zeroize_derive`: Copyright (c) 2019-2026 The RustCrypto Project Developers
- `cipher`: Copyright (c) 2016-2025 RustCrypto Developers
- `cmov`, `hybrid-array`: Copyright (c) 2022-2026 The RustCrypto Project Developers
- `concurrent-queue`: Authors: Stjepan Glavina, Taiki Endo, John Nunley
- `const-oid`, `cpufeatures` 0.3.1: Copyright (c) 2020-2026 The RustCrypto Project Developers
- `cookie`: Copyright (c) 2017 Sergio Benitez; Copyright (c) 2014 Alex Crichton
- `core-foundation`, `core-foundation-sys`, `core-graphics`, `core-graphics-types`,
  `string_cache`: Copyright (c) 2012-2013 Mozilla Foundation
- `core_detect`: Copyright (c) 2017-2020 The Rust Project Developers
- `cpubits`: Copyright (c) 2023-2026 The RustCrypto Project Developers
- `cpufeatures` 0.2.17: Copyright (c) 2020-2025 The RustCrypto Project Developers
- `crc32fast`: Copyright (c) 2018 Sam Rijs, Alex Crichton and contributors
- `crossbeam-channel`, `crossbeam-utils`: Copyright (c) 2019 The Crossbeam Project Developers
- `crypto-common` 0.1.7: Copyright (c) 2021 RustCrypto Developers
- `crypto-common` 0.2.2: Copyright (c) 2021-2026 RustCrypto Developers
- `ctor`: Author: Matt Mastracci
- `ctutils`: Copyright (c) 2025-2026 The RustCrypto Project Developers
- `darling`, `darling_core`, `darling_macro`: Copyright (c) 2017 Ted Driggs
- `dashmap`: Copyright (c) 2019 Acrimon
- `data-encoding`: Copyright (c) 2015-2020 Julien Cretin; Copyright (c) 2017-2020 Google Inc.
- `dbus`, `libdbus-sys`: Copyright (c) 2014-2018 David Henningsson and other contributors
- `deranged`: Copyright (c) 2024 Jacob Pratt et al.
- `derive_more`, `derive_more-impl`: Copyright (c) 2016 Jelte Fennema
- `digest` 0.10.7, `hmac`: Copyright (c) 2017 Artyom Pavlov
- `digest` 0.11.3: Copyright (c) 2017-2025 RustCrypto Developers; Copyright (c) 2017 Artyom Pavlov
- `directories`: Copyright (c) 2018 directories-rs contributors
- `dirs`, `dirs-sys`: Copyright (c) 2018-2019 dirs-rs contributors
- `dispatch2`: Authors: Mads Marquart, Mary
- `displaydoc`: Author: Jane Lusby
- `dlopen2`: Authors: Szymon Wieloch, Ahmed Masud, OpenByte
- `dlopen2_derive`: Authors: Szymon Wieloch, OpenByte
- `dom_query`: Copyright (c) 2023 Mykola Humanov
- `downcast-rs`: Copyright (c) 2020 Ashish Myles and contributors
- `dpi` (its copy of rust-lang/libm): Copyright (c) 2018 Jorge Aparicio; Copyright © 2005-2020
  Rich Felker, et al. Copyright © 1993,2004 Sun Microsystems or; Copyright © 2003-2011 David
  Schultz or; Copyright © 2003-2009 Steven G. Kargl or; Copyright © 2003-2009 Bruce D. Evans or;
  Copyright © 2008 Stephen L. Moshier or; Copyright © 2017-2018 Arm Limited
- `educe`, `enum-ordinalize`, `enum-ordinalize-derive`: Copyright (c) 2023 magiclen.org (Ron Li)
- `either`: Copyright (c) 2015
- `embed_plist`: Copyright (c) 2020 Nikolai Vazquez
- `encoding_rs`, `multiversion_no_op`, `utf8_iter`, `utf_types`: Copyright Mozilla Foundation
- `endi`: Author: Zeeshan Ali Khan
- `enumflags2`: Copyright (c) 2017-2023 Maik Klein, Maja Kądziołka
- `enumflags2_derive`: Copyright (c) 2017 Maik Klein
- `equivalent`: Copyright (c) 2016--2023
- `errno`: Copyright (c) 2014 Chris Wong
- `fax`: Copyright © 2021 The pdf-rs contributers.
- `fdeflate`, `image`: Author: The image-rs Developers
- `field-offset`: Copyright (c) 2016-2021 Diggory Blake, and other contributors.
- `file-id`, `notify-debouncer-full`, `notify-types`: Copyright (c) 2023 Notify Contributors
- `filedescriptor`, `portable-pty`: Copyright (c) 2018 Wez Furlong
- `fixedbitset`: Copyright (c) 2015-2017; Author: bluss
- `flate2`: Copyright (c) 2014-2026 Alex Crichton
- `fnv`: Copyright (c) 2017 Contributors
- `foreign-types`, `foreign-types-macros`, `foreign-types-shared`: Copyright (c) 2017 The
  foreign-types Developers
- `form_urlencoded`: Copyright (c) 2013-2016 The rust-url developers
- `futures`, `futures-channel`, `futures-core`, `futures-executor`, `futures-io`, `futures-macro`,
  `futures-sink`, `futures-task`, `futures-util`: Copyright (c) 2016 Alex Crichton; Copyright (c)
  2017 The Tokio Authors
- `generic-array`: Copyright (c) 2015 Bartłomiej Kamiński
- `getrandom` 0.2.17: Copyright (c) 2018-2024 The rust-random Project Developers; Copyright (c)
  2014 The Rust Project Developers
- `getrandom` 0.3.4: Copyright (c) 2018-2025 The rust-random Project Developers; Copyright (c)
  2014 The Rust Project Developers
- `getrandom` 0.4.3: Copyright (c) 2018-2026 The rust-random Project Developers; Copyright (c)
  2014 The Rust Project Developers
- `granit-parser`: Copyright (c) 2015 Chen Yuheng; Copyright (c) 2023 Ethiraric; Modifications
  after commit `825edf857426d034954523fed19599635cbb5043` are Copyright (c) 2026 Bourumir Wyngs
  and licensed under MIT OR Apache-2.0.
- `h2`: Copyright (c) 2017 h2 authors
- `half`: Author: Kathryn Long
- `hashbrown`: Copyright (c) 2016 Amanieu d'Antras
- `heck`, `unicode-segmentation`, `unicode-width`: Copyright (c) 2015 The Rust Project Developers
- `hex`: Copyright (c) 2013-2014 The Rust Project Developers. Copyright (c) 2015-2020 The rust-hex
  Developers
- `hkdf`: Copyright (c) 2015-2018 Vlad Filippov; Copyright (c) 2018-2021 RustCrypto Developers
- `hostname`: Copyright (c) 2016 fengcen; Copyright (c) 2019 svartalf
- `html5ever`, `markup5ever`, `web_atoms`: Copyright (c) 2014 The html5ever Project Developers
- `http`: Copyright (c) 2017 http-rs authors
- `http-body`, `http-body-util`: Copyright (c) 2019-2026 Sean McArthur & Hyper Contributors
- `httparse`: Copyright (c) 2015-2025 Sean McArthur
- `hyper`: Copyright (c) 2014-2026 Sean McArthur
- `hyper-rustls`, `rustls`, `rustls-native-certs`: Copyright (c) 2016 Joseph Birr-Pixton
- `hyper-timeout`: Copyright (c) 2016 The weldr Project Developers
- `hyper-util`: Copyright (c) 2023-2025 Sean McArthur
- `ico`: Copyright (c) 2018 Matthew D. Steele
- `ident_case`: Author: Ted Driggs
- `idna`, `percent-encoding`, `url`: Copyright (c) 2013-2025 The rust-url developers
- `idna_adapter`: Copyright (c) The rust-url developers
- `indexmap`: Copyright (c) 2016--2017
- `infer`: Copyright (c) 2019 Bojan
- `inout`: Copyright (c) 2022-2025 The RustCrypto Project Developers; Copyright (c) 2022 Artyom
  Pavlov
- `ipnet`: Copyright 2017 Juniper Networks, Inc.
- `is-docker`, `is-wsl`: Copyright (c) 2023 Sean Larkin
- `javascriptcore-rs`: Copyright (c) 2013-2021, The Gtk-rs Project Developers. Copyright (c) 2021,
  Tauri Programme within The Commons Conservancy.
- `javascriptcore-rs-sys`, `soup3`, `soup3-sys`: Copyright (c) 2013-2017, The Gtk-rs Project
  Developers.
- `json-patch`: Copyright (c) 2017 Ivan Dubrov
- `jsonpath-rust`: Copyright (c) [2021] [Boris Zhguchev]
- `jsonptr`: Copyright (c) 2022 Chance Dinkins
- `keyboard-types`: Copyright (c) 2017 Pyfisch
- `lazy_static`: Author: Marvin Löbel
- `libappindicator`: Copyright (c) 2017-2021 qDot; Copyright (c) 2021 Tauri Apps Contributors
- `libc`: Copyright (c) The Rust Project Developers
- `linux-raw-sys`: Copyrights in the `linux-raw-sys` project are retained by their contributors.
- `lock_api`, `parking_lot`, `parking_lot_core`, `thread_local`: Copyright (c) 2016 The Rust
  Project Developers
- `matchers`, `sharded-slab`: Copyright (c) 2019 Eliza Weisman
- `memoffset`: Copyright (c) 2017 Gilad Naaman
- `mime`: Copyright (c) 2014 Sean McArthur
- `miniz_oxide`: Copyright 2013-2014 RAD Game Tools and Valve Software; Copyright 2010-2014 Rich
  Geldreich and Tenacious Software LLC; Copyright (c) 2017 Frommi; Copyright (c) 2017-2024
  oyvindln
- `mio`: Copyright (c) 2014 Carl Lerche and other MIO contributors
- `muda`, `tray-icon`: Copyright (c) 2022-2022 Tauri Programme within The Commons Conservancy
- `new_debug_unreachable`, `ordered-float`: Copyright (c) 2015 Jonathan Reem
- `nix`: Copyright (c) 2015 Carl Lerche + nix-rust Authors
- `nohash-hasher`: Copyright 2018 Parity Technologies (UK) Ltd.
- `nom`: Copyright (c) 2014-2019 Geoffroy Couprie
- `nu-ansi-term`: Copyright (c) 2014 Benjamin Sago; Copyright (c) 2021-2022 The Nushell Project
  Developers
- `num-conv`: Copyright (c) Jacob Pratt
- `once_cell`: Author: Aleksey Kladov
- `open`: Copyright © `2015` `Sebastian Thiel`
- `ordered-stream`: Authors: Daniel De Graaf, Zeeshan Ali Khan
- `os_pipe`: Author: Jack O'Connor
- `parking`: Copyright 2014-2020 The Rust Project Developers; Authors: Stjepan Glavina, The Rust
  Project Developers
- `pem`: Copyright (c) 2016 Jonathan Creekmore
- `pest`, `pest_derive`, `pest_generator`, `pest_meta`: Author: Dragoș Tiselice
- `pest_stack_guard`: Author: Tomas Tauber
- `petgraph`: Copyright (c) 2015; Authors: bluss, mitchmindtree
- `phf`, `phf_generator`, `phf_macros`, `phf_shared`: Copyright (c) 2014-2022 Steven Fackler, Yuki
  Okushi
- `plist`: Copyright (c) 2015 Edward Barnard
- `png`: Copyright (c) 2015 nwin
- `powerfmt`: Copyright (c) 2023 Jacob Pratt et al.
- `precomputed-hash`: Copyright (c) 2017 Emilio Cobos Álvarez
- `proc-macro-crate`: Author: Bastian Köcher
- `proc-macro-error`, `proc-macro-error-attr`: Copyright (c) 2019-2020 CreepySkeleton
- `proc-macro2`: Authors: David Tolnay, Alex Crichton
- `psm`: Copyright © 2018, Simonas Kazlauskas
- `quick-error`: Copyright (c) 2015 The quick-error Developers
- `quick-xml`: Copyright (c) 2016 Johann Tuffe
- `rand`: Copyrights in the Rand project are retained by their contributors. Copyright 2018
  Developers of the Rand project; Copyright (c) 2014 The Rust Project Developers
- `rand_core`: Copyrights in the Rand project are retained by their contributors. Copyright (c)
  2018-2026 The Rand Project Developers
- `raw-window-handle`: Copyright (c) 2019 Osspial
- `reqwest`: Copyright (c) 2016-2026 Sean McArthur
- `rfd`: Copyright (c) 2022 Bartłomiej Maryńczak
- `rustc-hash`: Author: The Rust Project Developers
- `rustix`: Copyrights in the `rustix` project are retained by their contributors.
- `rustls-pki-types`: Copyright (c) 2023 Dirkjan Ochtman
- `rustls-platform-verifier`: Copyright (c) 2022 1Password
- `same-file`, `winapi-util`: Copyright (c) 2017 Andrew Gallant
- `schannel`: Copyright (c) 2015 steffengy
- `schemars`, `schemars_derive`: Copyright (c) 2019 Graham Esau
- `scopeguard`: Copyright (c) 2016-2019 Ulrik Sverdrup "bluss" and scopeguard developers
- `secrecy`: Copyright (c) 2019-2024 iqlusion
- `secret-service`: Copyright (c) 2025 secret-service Developers
- `security-framework`, `security-framework-sys`: Copyright (c) 2015 Steven Fackler
- `serde`, `serde_core`, `serde_derive`, `serde_derive_internals`: Authors: Erick Tryzelaar, David
  Tolnay
- `serde-value`: Copyright (c) 2016 arcnmx
- `serde_with`: Copyright (c) 2015; Authors: Jonas Bushart, Marcin Kaźmierczak
- `serde_with_macros`: Copyright (c) 2015; Author: Jonas Bushart
- `serde_yaml_ng`: Copyright 2024 Antoine Catton; Copyright 2016-2024 David Tolnay
- `serialize-to-javascript`, `serialize-to-javascript-impl`: Copyright (c) 2021 Chip Reed
- `servo_arc`: Author: The Servo Project Developers
- `sha1`, `sha2` 0.11.1: Copyright (c) 2016-2026 The RustCrypto Project Developers; Copyright (c)
  2016 Artyom Pavlov; Copyright (c) 2009-2013 Mozilla Foundation; Copyright (c) 2006-2009 Graydon
  Hoare
- `sha2` 0.10.9: Copyright (c) 2006-2009 Graydon Hoare; Copyright (c) 2009-2013 Mozilla
  Foundation; Copyright (c) 2016 Artyom Pavlov
- `shared_library`: Copyright (c) 2017 Pierre Krieger
- `shell-words`: Copyright (c) 2016 Tomasz Miąsko
- `signal-hook-registry`: Copyright (c) 2017 tokio-jsonrpc developers
- `simd-adler32`: Copyright (c) [2021] [Marvin Countryman]
- `simdutf8`: Author: Hans Kratz
- `siphasher`: Author: Frank Denis
- `slab`: Copyright (c) 2019 Carl Lerche
- `smallvec`: Copyright (c) 2018 The Servo Project Developers
- `softbuffer`: Copyright 2022 Kirill Chibisov
- `stable_deref_trait`: Copyright (c) 2017 Robert Grosse
- `strsim`: Copyright (c) 2015 Danny Guo; Copyright (c) 2016 Titus Wormer; Copyright (c) 2018
  Akash Kurdekar
- `symlink`: Copyright (c) 2014 Chris Morgan and the Teepee project developers
- `synstructure`: Copyright 2016 Nika Layzell
- `system-configuration`, `system-configuration-sys`: Copyright (c) 2024 Mullvad VPN AB
- `tar`: Copyright (c) The tar-rs Project Contributors
- `tauri`, `tauri-codegen`, `tauri-macros`, `tauri-plugin-clipboard-manager`,
  `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-opener`, `tauri-runtime`,
  `tauri-runtime-wry`, `tauri-utils`: Copyright (c) 2017 - Present Tauri Apps Contributors
- `tempfile`: Copyright (c) 2015 Steven Allen
- `tendril`: Copyright (c) 2015 Keegan McAllister
- `tiff`: Copyright (c) 2018 PistonDevelopers
- `time`, `time-core`, `time-macros`: Copyright (c) Jacob Pratt et al.
- `tokio`, `tokio-util`: Copyright (c) Tokio Contributors
- `tokio-macros`: Copyright (c) 2019 Yoshua Wuyts; Copyright (c) Tokio Contributors
- `tokio-rustls`: Copyright (c) 2017 quininer kel
- `tokio-tungstenite`: Copyright (c) 2017 Daniel Abramov; Copyright (c) 2017 Alexey Galakhov
- `tower`, `tower-layer`, `tower-service`: Copyright (c) 2019 Tower Contributors
- `tower-http`: Copyright (c) 2019-2021 Tower Contributors
- `tracing`, `tracing-appender`, `tracing-attributes`, `tracing-core`, `tracing-log`,
  `tracing-subscriber`: Copyright (c) 2019 Tokio Contributors
- `tree_magic_mini`: Copyright (c) 2017 Aaron Hancock
- `try-lock`: Copyright (c) 2018-2023 Sean McArthur; Copyright (c) 2016 Alex Crichton
- `ts-rs`, `ts-rs-macros`: Author: Moritz Bischof
- `tungstenite`: Copyright (c) 2017 Alexey Galakhov; Copyright (c) 2016 Jason Housley
- `typed-path`: Author: Chip Senkbeil
- `typenum`: Copyright (c) 2014 Paho Lurie-Gregg
- `urlpattern`: Copyright (c) 2021 the Deno authors
- `uuid`: Copyright (c) 2014 The Rust Project Developers; Copyright (c) 2018 Ashley Mannix,
  Christopher Armstrong, Dylan DPC, Hunar Roop Kahlon
- `want`: Copyright (c) 2018-2019 Sean McArthur
- `wayland-backend`, `wayland-client`, `wayland-protocols`, `wayland-protocols-wlr`,
  `wayland-scanner`, `wayland-sys`: Copyright (c) 2015 Elinor Berger
- `web-time`: Copyright (c) 2023 dAxpeDDa
- `webkit2gtk`: Copyright (c) 2016 Boucher, Antoni; Copyright (c) 2017-2021, The Gtk-rs Project
  Developers. Copyright (c) 2021, Tauri Programme within The Commons Conservancy
- `webkit2gtk-sys`: Copyright (c) 2016 Boucher, Antoni
- `weezl`: Copyright (c) HeroicKatora 2020
- `winapi`: Copyright (c) 2015-2018 The winapi-rs Developers
- `window-vibrancy`: Copyright (c) 2020-2022 Tauri Programme within The Commons Conservancy
- `windows`, `windows-collections`, `windows-core`, `windows-future`, `windows-implement`,
  `windows-interface`, `windows-link`, `windows-numerics`, `windows-registry`, `windows-result`,
  `windows-strings`, `windows-sys`, `windows-targets`, `windows-threading`, `windows-version`,
  `windows_x86_64_msvc`: Copyright (c) Microsoft Corporation.
- `winreg`: Copyright (c) 2015 Igor Shaula
- `wl-clipboard-rs`: Copyright (c) 2019 Ivan Molodetskikh
- `wry`: Copyright (c) 2020-2023 Ngo Iok Ui & Tauri Programme within The Commons Conservancy
- `x11`, `x11-dl`: Authors: daggerbot, Erle Pereira, AltF02
- `x11rb`, `x11rb-protocol`: Copyright 2019 x11rb Contributers
- `zbus`, `zbus_macros`, `zbus_names`, `zvariant`, `zvariant_derive`: Copyright (c) 2024 Zeeshan
  Ali Khan & zbus contributors
- `zcheapstr`: Copyright (c) 2026 Zeeshan Ali Khan & zcheapstr contributors
- `zerocopy`, `zerocopy-derive`: Copyright 2023 The Fuchsia Authors
- `zeroize`: Copyright (c) 2018-2026 The RustCrypto Project Developers
- `zip`: Copyright (c) 2014 Mathijs van de Nes
- `zune-core`, `zune-jpeg`: Copyright (c) zune-image developers
- `zvariant_utils`: Authors: Zeeshan Ali Khan, turbocooler
- `blocking`, `cargo-platform`, `libappindicator-sys`, `objc2-app-kit`, `objc2-core-foundation`,
  `objc2-core-graphics`, `objc2-core-services`, `objc2-foundation`, `objc2-quartz-core`,
  `objc2-web-kit`, `pin-project`, `pin-project-internal`, `pin-project-lite`, `serde-saphyr`,
  `serde_json`, `webview2-com`, `webview2-com-macros`, `webview2-com-sys`, `winnow`: no copyright
  line or author stated

Apache-2.0, the license in `LICENSE` (`dpi`'s copy of rust-lang/libm is MIT, listed above):

- `backon`: Copyright 2021 Datafuse Labs
- `gethostname`: Author: Sebastian Wiesner
- `k8s-openapi`: Author: Arnav Singh
- `kube`, `kube-client`, `kube-core`, `kube-runtime`: Authors: clux, Natalie Klestrup Röijezon,
  kazk
- `moxcms`, `pxfm`: Copyright 2024 Radzivon Bartoshyk
- `serial2`: Copyright 2021, Maarten de Vries
- `sync_wrapper`: Author: Actyx AG
- `tao`: Copyright 2021-2023, The Tauri Programme in the Commons Conservancy; Authors: Tauri
  Programme within The Commons Conservancy, The winit contributors
- `dpi`: no copyright line or author stated

BSD-3-Clause (`brotli` is also under MIT, listed above; so is `encoding_rs`, except its WHATWG
data):

- `alloc-no-stdlib`, `brotli`, `brotli-decompressor`: Copyright (c) 2016 Dropbox, Inc.
- `alloc-stdlib`: Author: Daniel Reiter Horn
- `encoding_rs` (data from the WHATWG Encoding Standard): Copyright © WHATWG (Apple, Google,
  Mozilla, Microsoft).
- `subtle`: Copyright (c) 2016-2017 Isis Agora Lovecruft, Henry de Valence. All rights reserved.
  Copyright (c) 2016-2024 Isis Agora Lovecruft. All rights reserved.

ISC (`ring` also has Apache-2.0 parts; see below):

- `inotify`, `inotify-sys`: Copyright (c) Hanno Braun and contributors
- `libloading`: Copyright © 2015, Simonas Kazlauskas
- `ring`: Copyright 2015-2025 Brian Smith. Copyright 2016 David Judd. Copyright 2016 Simon Sapin.
  Copyright 2018 Trent Clarke. Copyright (c) 2014, Google Inc. Copyright (c) 2014, 2015, Google
  Inc. Copyright (c) 2015, Google Inc. Copyright (c) 2016, Google Inc. Copyright (c) 2019, Google
  Inc. Copyright (c) 2014, Intel Corporation.
- `rustls-webpki`: Copyright 2015 Brian Smith.
- `untrusted`: Copyright 2015-2016 Brian Smith.

Unicode-3.0 (`unicode-ident` is MIT, listed above, apart from its Unicode data):

- `icu_collections`, `icu_locale_core`, `icu_normalizer`, `icu_normalizer_data`, `icu_properties`,
  `icu_properties_data`, `icu_provider`, `litemap`, `potential_utf`, `tinystr`, `writeable`,
  `yoke`, `yoke-derive`, `zerofrom`, `zerofrom-derive`, `zerotrie`, `zerovec`, `zerovec-derive`:
  Copyright © 2020-2024 Unicode, Inc. Portions of ICU4X may have been adapted from ICU4C and/or
  ICU4J. ICU 1.8.1 to ICU 57.1 © 1995-2016 International Business Machines Corporation and others.
- `unicode-ident`: Copyright © 1991-2023 Unicode, Inc.

MPL-2.0, applied file by file and used unmodified. The text is at
https://mozilla.org/MPL/2.0/, and each crate's source is at the address given:

- `cssparser`: Author: Simon Sapin; https://crates.io/crates/cssparser/0.37.0
- `cssparser-macros`: Author: Simon Sapin; https://crates.io/crates/cssparser-macros/0.7.1
- `dtoa-short`: Author: Xidorn Quan; https://crates.io/crates/dtoa-short/0.3.5
- `option-ext`: Author: Simon Ochsenreither; https://crates.io/crates/option-ext/0.2.0
- `selectors`: Author: The Servo Project Developers; https://crates.io/crates/selectors/0.38.0

Other notices:

- `ring` takes code from BoringSSL and fiat-crypto under Apache-2.0, with the notices of The
  OpenSSL Project Authors, The BoringSSL Authors, Intel Corporation, CloudFlare, Oracle, ARM and
  the fiat-crypto authors.
- `webview2-com-sys` (MIT) carries Microsoft's WebView2 loader from the WebView2 SDK, which the
  Windows build links statically; the loader is under the WebView2 SDK's license.
- Third-party code in `atomic-waker`, `futures-lite` and `parking` is under MIT and listed above.
  The third-party files of `crossbeam-channel`, `security-framework` and `libdbus-sys` cover
  tests, documentation and a vendored build that the app does not compile.
- No notice is needed for `ryu`, `clipboard-win` and `error-code` (BSL-1.0, which asks for it
  only in source), for `constant_time_eq`, `dunce` and `notify` (CC0-1.0) or for `foldhash`
  (zlib, which asks for it only in source).

## License texts

The Apache License 2.0 is in `LICENSE`, which ships beside this file. The Mozilla Public
License 2.0 is at https://mozilla.org/MPL/2.0/.

### MIT License

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License

```text
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### BSD 3-Clause License

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Markdown license

```text
Copyright © 2004, John Gruber
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.
```

### Unicode License v3

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

### SIL Open Font License 1.1

```text
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
