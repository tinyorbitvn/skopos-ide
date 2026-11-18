# Third-party notices

SkoposIDE is new code, written for this project. Parts of its logic are adapted from the
open-source projects below, whose license requires this notice to stay with the code.
The app also bundles fonts, icons and npm packages. Their sections below, from
[Fonts](#fonts) on, carry the copyright notices and license texts that their licenses ask
every copy to keep. [Rust crates](#rust-crates) does the same for the crates that the app
links, pinned in `Cargo.lock`.

## Freelens

- Source: https://github.com/freelensapp/freelens
- Reference commit: `3f2b73426bab36e68c31bb2c403e815187148ad7`
- License: MIT

```text
MIT License

Copyright (c) 2024-2026 Freelens Authors.

Copyright (c) 2022 OpenLens Authors.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Kubernetes

Status strings and the drain behaviour follow `kubectl`, part of the Kubernetes project
(https://github.com/kubernetes/kubernetes and https://github.com/kubernetes/kubectl).
Copyright The Kubernetes Authors. Licensed under Apache-2.0, whose text is in this file.

## Argo CD

- Source: https://github.com/argoproj/argo-cd
- Reference tag: `v3.6.1`, commit `94037c4d4e1af4bd0651d37a179fbd9e347e668c`
- License: Apache-2.0, whose text is in this file. Copyright 2017-2018 The Argo Authors. The
  project has no NOTICE file.

The Argo CD actions write an Application the way the Argo CD API server does
(`server/application/application.go` and `util/argo/argo.go`). The tests install its CRDs and
`manifests/core-install.yaml` from that commit.

## Kubernetes Icons Set

- Source: https://github.com/kubernetes/community, `icons/svg/resources/unlabeled/`
- Reference commit: `a222663ef579405457f78f9fe3c077894565a918`
- License: Apache-2.0, whose text is in this file, chosen of the two the set offers (Apache-2.0
  and CC-BY-4.0). Copyright The Kubernetes Authors.

The resource map draws 19 of these icons (`pod`, `deploy`, `rs`, `sts`, `ds`, `job`,
`cronjob`, `svc`, `ing`, `cm`, `secret`, `sa`, `pvc`, `ns`, `crd`, `role`, `rb`, `c-role`,
`crb`). `ui/scripts/packK8sIcons.mjs` packs them into path data in
`ui/src/features/map/icons/k8sIcons.ts` and leaves their shapes and colours unchanged. The
Gateway, HTTPRoute and GatewayClass icons put a Lucide glyph in the frame of the set's Ingress
icon; see [Lucide](#lucide).

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
the SIL Open Font License 1.1, whose text follows.

- **Manrope** (`@fontsource/manrope` 5.3): Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)
- **JetBrains Mono** (`@fontsource/jetbrains-mono` 5.3): Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

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

## Lucide

- Source: https://github.com/lucide-icons/lucide
- Package: `lucide-react` 1.69
- License: ISC. The icons that Lucide derives from Feather are under MIT; the license below
  lists them.

The interface draws its icons from `lucide-react`, and the resource map's Gateway, HTTPRoute
and GatewayClass icons put a Lucide glyph in the frame of the Kubernetes Ingress icon. The
package's license follows unchanged.

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

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

## npm packages

The interface (`ui/`) is built by Vite from the npm packages below: the production
dependencies that `pnpm -C ui licenses list --prod` reports, less the type declarations
(`@types/*` and `csstype`), which do not ship. The fonts and Lucide have their own sections
above. Run that command again when the dependencies change.

### MIT License

These packages are under the MIT License. The Tauri packages offer MIT or Apache-2.0, and
SkoposIDE takes MIT. The copyright notices follow as each package states them; the
Tauri plugins and `react-remove-scroll-bar` ship no license file, so theirs come from the
package's SPDX file and `package.json`. The license text after the notices is the same for
every package.

```text
@radix-ui/* (every package of the Radix Primitives scope)
  Copyright (c) 2022 WorkOS

@dnd-kit/accessibility, @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities
  Copyright (c) 2021, Claudéric Demers

@floating-ui/core, @floating-ui/dom, @floating-ui/react-dom, @floating-ui/utils
  Copyright (c) 2021-present Floating UI contributors

@remix-run/route-pattern
  Copyright (c) 2025 Shopify Inc.

@tanstack/react-virtual, @tanstack/virtual-core
  Copyright (c) 2021-present Tanner Linsley

@tauri-apps/api
  Copyright (c) 2017 - Present Tauri Apps Contributors
  Copyright 2019-2025, The Tauri Programme in the Commons Conservancy

@tauri-apps/plugin-clipboard-manager, @tauri-apps/plugin-dialog
  Copyright 2019-2022, The Tauri Programme in the Commons Conservancy

@xterm/xterm
  Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
  Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
  Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

@xterm/addon-fit
  Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

aria-hidden, react-remove-scroll, react-style-singleton, use-callback-ref, use-sidecar
  Copyright (c) 2017 Anton Korzunov

get-nonce
  Copyright (c) 2020 Anton Korzunov

react-remove-scroll-bar
  Author: Anton Korzunov <thekashey@gmail.com>

cookie-es
  Cookie-es copyright (c) Pooya Parsa <pooya@pi0.io>

  Cookie parsing based on https://github.com/jshttp/cookie
  Copyright (c) 2012-2014 Roman Shtylman <shtylman@gmail.com>
  Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com>

  Set-Cookie parsing based on https://github.com/nfriedly/set-cookie-parser
  Copyright (c) 2015 Nathan Friedly <nathan@nfriedly.com> (http://nfriedly.com/)

detect-node-es
  Copyright (c) 2017 Ilya Kantor

marked, and its copy inside monaco-editor
  Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
  Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)
  Copyright (c) 2011-2024, Christopher Jeffrey.

monaco-editor
  Copyright (c) 2016 - present Microsoft Corporation

The Node.js path library inside monaco-editor
  Copyright Joyent, Inc. and other Node contributors.

react, react-dom, scheduler
  Copyright (c) Meta Platforms, Inc. and affiliates.

react-router
  Copyright (c) React Training LLC 2015-2019
  Copyright (c) Remix Software Inc. 2020-2021
  Copyright (c) Shopify Inc. 2022-2023

zustand
  Copyright (c) 2019 Paul Henschel
```

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

### Markdown, in marked

The license file of `marked` also carries the license of Markdown:

```text
Copyright © 2004, John Gruber
http://daringfireball.net/
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.
```

### ISC License

The `yaml` package is under the ISC License:

```text
Copyright Eemeli Aro <eemeli@gmail.com>

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

### DOMPurify

- Source: https://github.com/cure53/DOMPurify
- License: Apache-2.0, whose text is in this file, chosen of the two it offers (Apache-2.0 and
  MPL-2.0). Copyright (c) Cure53 and other contributors. The package has no NOTICE file.

The app bundles the copy that `monaco-editor` carries in `esm/vs/base/browser/dompurify/`.
The `dompurify` package in the dependency tree is under the same terms.

### monaco-editor's own notices

`monaco-editor` ships a `ThirdPartyNotices.txt` for components inside it. The app's build
holds two of them, credited above: the Node.js path library and marked. The others
(TypeScript, the HTML 5.1 W3C Working Draft, JS Beautifier, the Ionic documentation and
vscode-swift) belong to language services and languages that the app does not bundle.

### No notice required

- **tslib** (0BSD): Copyright (c) Microsoft Corporation. Its license grants use with no
  conditions, so it asks for no notice; it is listed so the list is complete.

## Rust crates

The app's binary is built from `skopos-app`, `skopos-core` and the 542 crates below: the
dependencies that `cargo tree -p skopos-app -e normal --target <triple>` lists for the four
release targets (`x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, `x86_64-apple-darwin` and
`x86_64-pc-windows-msvc`), at the versions pinned in `Cargo.lock`. The list includes the
procedural macros, which run while the app is built and write part of its code. Build scripts,
their dependencies, dev-dependencies and crates for other targets are left out. Run that command
again when the dependencies change.

Where a crate offers the MIT License, SkoposIDE takes MIT. Where it offers no MIT but a license
that asks no notice of a binary (CC0-1.0 or BSL-1.0), SkoposIDE takes that one, and between
Apache-2.0 and a BSD license it takes Apache-2.0. `brotli-decompressor` offers BSD-3-Clause or
MIT but ships only the BSD-3-Clause text, so it is listed under BSD-3-Clause. No crate in the list
ships an Apache-2.0 NOTICE file.

### Crates under MIT

These crates are under the MIT License, or offer it among other licenses. The copyright
notices follow as each crate's license files state them. Where a crate's license files carry no
copyright line, or one with a year but no name, the authors follow as the crate's `Cargo.toml`
lists them. The crates in the last group state neither. The license text after the notices is
the same for every crate.

```text
adler2
  Authors: Jonas Schievink <jonasschievink@gmail.com>, oyvindln <oyvindln@users.noreply.github.com>

aes
  Copyright (c) 2018-2024 The RustCrypto Project Developers
  Copyright (c) 2018 Artyom Pavlov

ahash
  Copyright (c) 2018 Tom Kaitchuck

aho-corasick, byteorder, byteorder-lite, encoding_rs_io, jiff, jiff-core, memchr, termcolor,
ucd-trie, walkdir
  Copyright (c) 2015 Andrew Gallant

allocator-api2
  Author: Zakarum <zaq.dev@icloud.com>

annotate-snippets, anstyle, serde_spanned, toml, toml_datetime 1.1.2+spec-1.1.0, toml_edit,
toml_parser, toml_writer
  Copyright (c) Individual contributors

anyhow, async-trait, dtoa, dyn-clone, erased-serde, itoa, quote, semver, serde-untagged,
serde_repr, syn, thiserror, thiserror-impl, typeid, unicode-ident, unsafe-libyaml, zmij
  Author: David Tolnay <dtolnay@gmail.com>

apple-native-keyring-store, keyring, keyring-core, windows-native-keyring-store,
zbus-secret-service-keyring-store
  Copyright (c) 2016 keyring Developers

arboard
  Copyright (c) 2022 The Arboard contributors

arraydeque
  Copyright (c) 2018 Andy Lok <andylokandy@hotmail.com>

async-broadcast
  Copyright (c) 2020 Yoshua Wuyts

async-channel, async-io, async-lock, async-process, async-task, fastrand
  Author: Stjepan Glavina <stjepang@gmail.com>

async-compression, compression-codecs, compression-core
  Copyright (c) 2018 the rustasync developers

async-executor, event-listener, piper, polling
  Authors: Stjepan Glavina <stjepang@gmail.com>, John Nunley <dev@notgull.net>

async-recursion
  Author: Robert Usher <266585+dcchut@users.noreply.github.com>

async-signal, event-listener-strategy
  Author: John Nunley <dev@notgull.net>

async-stream, async-stream-impl
  Copyright (c) 2019 Carl Lerche
  Copyright (c) 2018 David Tolnay

atk, cairo-rs, gdk, gdk-pixbuf, gdkx11, gio, glib, glib-macros, gtk, gtk3-macros, pango
  Copyrights in the gtk-rs Project project are retained by their contributors.

atk-sys, cairo-sys-rs, gdk-pixbuf-sys, gdk-sys, gdkwayland-sys, gdkx11-sys, gio-sys,
glib-sys, gobject-sys, gtk-sys, pango-sys
  Author: The gtk-rs Project Developers

atomic-waker, futures-lite
  Copyright (c) 2016 Alex Crichton
  Copyright (c) 2017 The Tokio Authors
  Authors: Stjepan Glavina <stjepang@gmail.com>, Contributors to futures-rs

base64 0.22.1
  Copyright (c) 2015 Alice Maz

base64 0.23.1
  Copyright (c) 2025 Alice Maz, Marshall Pierce

bit-set, bit-vec
  Copyright (c) 2023 The Rust Project Developers

bitflags, glob, log, num, num-bigint, num-complex, num-integer, num-iter, num-rational,
num-traits, regex, regex-automata, regex-syntax
  Copyright (c) 2014 The Rust Project Developers

block-buffer 0.10.4
  Copyright (c) 2018-2019 The RustCrypto Project Developers

block-buffer 0.12.1, block-padding
  Copyright (c) 2018-2025 The RustCrypto Project Developers

block2, objc2, objc2-encode, objc2-exception-helper
  Author: Mads Marquart <mads@marquart.dk>

brotli
  Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors.

bytemuck
  Copyright (c) 2019 Daniel "Lokathor" Gee.

bytes
  Copyright (c) 2018 Carl Lerche

camino
  Authors: Without Boats <saoirse@without.boats>, Ashley Williams <ashley666ashley@gmail.com>, Steve Klabnik <steve@steveklabnik.com>, Rain <rain@sunshowers.io>

cargo_metadata
  Author: Oliver Schneider <git-spam-no-reply9815368754983@oli-obk.de>

cbc
  Copyright (c) 2018-2022 RustCrypto Developers
  Copyright (c) 2018 Artyom Pavlov

cfb
  Copyright (c) 2017 Matthew D. Steele

cfg-if, filetime, openssl-probe, socket2, stacker, toml_datetime 0.6.3
  Copyright (c) 2014 Alex Crichton

chacha20, zeroize_derive
  Copyright (c) 2019-2026 The RustCrypto Project Developers

cipher
  Copyright (c) 2016-2025 RustCrypto Developers

cmov, hybrid-array
  Copyright (c) 2022-2026 The RustCrypto Project Developers

concurrent-queue
  Authors: Stjepan Glavina <stjepang@gmail.com>, Taiki Endo <te316e89@gmail.com>, John Nunley <dev@notgull.net>

const-oid, cpufeatures 0.3.1
  Copyright (c) 2020-2026 The RustCrypto Project Developers

cookie
  Copyright (c) 2017 Sergio Benitez
  Copyright (c) 2014 Alex Crichton

core-foundation, core-foundation-sys, core-graphics, core-graphics-types, string_cache
  Copyright (c) 2012-2013 Mozilla Foundation

core_detect
  Copyright (c) 2017-2020 The Rust Project Developers

cpubits
  Copyright (c) 2023-2026 The RustCrypto Project Developers

cpufeatures 0.2.17
  Copyright (c) 2020-2025 The RustCrypto Project Developers

crc32fast
  Copyright (c) 2018 Sam Rijs, Alex Crichton and contributors

crossbeam-channel, crossbeam-utils
  Copyright (c) 2019 The Crossbeam Project Developers

crypto-common 0.1.7
  Copyright (c) 2021 RustCrypto Developers

crypto-common 0.2.2
  Copyright (c) 2021-2026 RustCrypto Developers

ctor
  Author: Matt Mastracci <matthew@mastracci.com>

ctutils
  Copyright (c) 2025-2026 The RustCrypto Project Developers

darling, darling_core, darling_macro
  Copyright (c) 2017 Ted Driggs

dashmap
  Copyright (c) 2019 Acrimon

data-encoding
  Copyright (c) 2015-2020 Julien Cretin
  Copyright (c) 2017-2020 Google Inc.

dbus, libdbus-sys
  Copyright (c) 2014-2018 David Henningsson <diwic@ubuntu.com> and other contributors

deranged
  Copyright (c) 2024 Jacob Pratt et al.

derive_more, derive_more-impl
  Copyright (c) 2016 Jelte Fennema

digest 0.10.7, hmac
  Copyright (c) 2017 Artyom Pavlov

digest 0.11.3
  Copyright (c) 2017-2025 RustCrypto Developers
  Copyright (c) 2017 Artyom Pavlov

directories
  Copyright (c) 2018 directories-rs contributors

dirs, dirs-sys
  Copyright (c) 2018-2019 dirs-rs contributors

dispatch2
  Authors: Mads Marquart <mads@marquart.dk>, Mary <mary@mary.zone>

displaydoc
  Author: Jane Lusby <jlusby@yaah.dev>

dlopen2
  Authors: Szymon Wieloch <szymon.wieloch@gmail.com>, Ahmed Masud <ahmed.masud@saf.ai>, OpenByte <development.openbyte@gmail.com>

dlopen2_derive
  Authors: Szymon Wieloch <szymon.wieloch@gmail.com>, OpenByte <development.openbyte@gmail.com>

dom_query
  Copyright (c) 2023 Mykola Humanov

downcast-rs
  Copyright (c) 2020 Ashish Myles and contributors

dpi (its copy of rust-lang/libm)
  Copyright (c) 2018 Jorge Aparicio
  Copyright © 2005-2020 Rich Felker, et al.
  Copyright © 1993,2004 Sun Microsystems or
  Copyright © 2003-2011 David Schultz or
  Copyright © 2003-2009 Steven G. Kargl or
  Copyright © 2003-2009 Bruce D. Evans or
  Copyright © 2008 Stephen L. Moshier or
  Copyright © 2017-2018 Arm Limited

educe, enum-ordinalize, enum-ordinalize-derive
  Copyright (c) 2023 magiclen.org (Ron Li)

either
  Copyright (c) 2015

embed_plist
  Copyright (c) 2020 Nikolai Vazquez

encoding_rs, multiversion_no_op, utf8_iter, utf_types
  Copyright Mozilla Foundation

endi
  Author: Zeeshan Ali Khan <zeenix@gmail.com>

enumflags2
  Copyright (c) 2017-2023 Maik Klein, Maja Kądziołka

enumflags2_derive
  Copyright (c) 2017 Maik Klein

equivalent
  Copyright (c) 2016--2023

errno
  Copyright (c) 2014 Chris Wong

fax
  Copyright © 2021 The pdf-rs contributers.

fdeflate, image
  Author: The image-rs Developers

field-offset
  Copyright (c) 2016-2021 Diggory Blake, and other contributors.

file-id, notify-debouncer-full, notify-types
  Copyright (c) 2023 Notify Contributors

filedescriptor, portable-pty
  Copyright (c) 2018 Wez Furlong

fixedbitset
  Copyright (c) 2015-2017
  Author: bluss

flate2
  Copyright (c) 2014-2026 Alex Crichton

fnv
  Copyright (c) 2017 Contributors

foreign-types, foreign-types-macros, foreign-types-shared
  Copyright (c) 2017 The foreign-types Developers

form_urlencoded
  Copyright (c) 2013-2016 The rust-url developers

futures, futures-channel, futures-core, futures-executor, futures-io, futures-macro,
futures-sink, futures-task, futures-util
  Copyright (c) 2016 Alex Crichton
  Copyright (c) 2017 The Tokio Authors

generic-array
  Copyright (c) 2015 Bartłomiej Kamiński

getrandom 0.2.17
  Copyright (c) 2018-2024 The rust-random Project Developers
  Copyright (c) 2014 The Rust Project Developers

getrandom 0.3.4
  Copyright (c) 2018-2025 The rust-random Project Developers
  Copyright (c) 2014 The Rust Project Developers

getrandom 0.4.3
  Copyright (c) 2018-2026 The rust-random Project Developers
  Copyright (c) 2014 The Rust Project Developers

granit-parser
  Copyright (c) 2015 Chen Yuheng
  Copyright (c) 2023 Ethiraric
  Modifications after commit `825edf857426d034954523fed19599635cbb5043` are Copyright (c) 2026 Bourumir Wyngs and licensed under MIT OR Apache-2.0.

h2
  Copyright (c) 2017 h2 authors

half
  Author: Kathryn Long <squeeself@gmail.com>

hashbrown
  Copyright (c) 2016 Amanieu d'Antras

heck, unicode-segmentation, unicode-width
  Copyright (c) 2015 The Rust Project Developers

hex
  Copyright (c) 2013-2014 The Rust Project Developers.
  Copyright (c) 2015-2020 The rust-hex Developers

hkdf
  Copyright (c) 2015-2018 Vlad Filippov
  Copyright (c) 2018-2021 RustCrypto Developers

hostname
  Copyright (c) 2016 fengcen
  Copyright (c) 2019 svartalf

html5ever, markup5ever, web_atoms
  Copyright (c) 2014 The html5ever Project Developers

http
  Copyright (c) 2017 http-rs authors

http-body, http-body-util
  Copyright (c) 2019-2026 Sean McArthur & Hyper Contributors

httparse
  Copyright (c) 2015-2025 Sean McArthur

hyper
  Copyright (c) 2014-2026 Sean McArthur

hyper-rustls, rustls, rustls-native-certs
  Copyright (c) 2016 Joseph Birr-Pixton <jpixton@gmail.com>

hyper-timeout
  Copyright (c) 2016 The weldr Project Developers

hyper-util
  Copyright (c) 2023-2025 Sean McArthur

ico
  Copyright (c) 2018 Matthew D. Steele

ident_case
  Author: Ted Driggs <ted.driggs@outlook.com>

idna, percent-encoding, url
  Copyright (c) 2013-2025 The rust-url developers

idna_adapter
  Copyright (c) The rust-url developers

indexmap
  Copyright (c) 2016--2017

infer
  Copyright (c) 2019 Bojan

inout
  Copyright (c) 2022-2025 The RustCrypto Project Developers
  Copyright (c) 2022 Artyom Pavlov

ipnet
  Copyright 2017 Juniper Networks, Inc.

is-docker, is-wsl
  Copyright (c) 2023 Sean Larkin

javascriptcore-rs
  Copyright (c) 2013-2021, The Gtk-rs Project Developers.
  Copyright (c) 2021, Tauri Programme within The Commons Conservancy.

javascriptcore-rs-sys, soup3, soup3-sys
  Copyright (c) 2013-2017, The Gtk-rs Project Developers.

json-patch
  Copyright (c) 2017 Ivan Dubrov

jsonpath-rust
  Copyright (c) [2021] [Boris Zhguchev]

jsonptr
  Copyright (c) 2022 Chance Dinkins

keyboard-types
  Copyright (c) 2017 Pyfisch

lazy_static
  Author: Marvin Löbel <loebel.marvin@gmail.com>

libappindicator
  Copyright (c) 2017-2021 qDot
  Copyright (c) 2021 Tauri Apps Contributors

libc
  Copyright (c) The Rust Project Developers

linux-raw-sys
  Copyrights in the `linux-raw-sys` project are retained by their contributors.

lock_api, parking_lot, parking_lot_core, thread_local
  Copyright (c) 2016 The Rust Project Developers

matchers, sharded-slab
  Copyright (c) 2019 Eliza Weisman

memoffset
  Copyright (c) 2017 Gilad Naaman

mime
  Copyright (c) 2014 Sean McArthur

miniz_oxide
  Copyright 2013-2014 RAD Game Tools and Valve Software
  Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC
  Copyright (c) 2017 Frommi
  Copyright (c) 2017-2024 oyvindln

mio
  Copyright (c) 2014 Carl Lerche and other MIO contributors

muda, tray-icon
  Copyright (c) 2022-2022 Tauri Programme within The Commons Conservancy

new_debug_unreachable, ordered-float
  Copyright (c) 2015 Jonathan Reem

nix
  Copyright (c) 2015 Carl Lerche + nix-rust Authors

nohash-hasher
  Copyright 2018 Parity Technologies (UK) Ltd.

nom
  Copyright (c) 2014-2019 Geoffroy Couprie

nu-ansi-term
  Copyright (c) 2014 Benjamin Sago
  Copyright (c) 2021-2022 The Nushell Project Developers

num-conv
  Copyright (c) Jacob Pratt

once_cell
  Author: Aleksey Kladov <aleksey.kladov@gmail.com>

open
  Copyright © `2015` `Sebastian Thiel`

ordered-stream
  Authors: Daniel De Graaf <code@danieldg.net>, Zeeshan Ali Khan <zeeshanak@gnome.org>

os_pipe
  Author: Jack O'Connor

parking
  Copyright 2014-2020 The Rust Project Developers
  Authors: Stjepan Glavina <stjepang@gmail.com>, The Rust Project Developers

pem
  Copyright (c) 2016 Jonathan Creekmore

pest, pest_derive, pest_generator, pest_meta
  Author: Dragoș Tiselice <dragostiselice@gmail.com>

pest_stack_guard
  Author: Tomas Tauber <me@tomtau.be>

petgraph
  Copyright (c) 2015
  Authors: bluss, mitchmindtree

phf, phf_generator, phf_macros, phf_shared
  Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi

plist
  Copyright (c) 2015 Edward Barnard

png
  Copyright (c) 2015 nwin

powerfmt
  Copyright (c) 2023 Jacob Pratt et al.

precomputed-hash
  Copyright (c) 2017 Emilio Cobos Álvarez

proc-macro-crate
  Author: Bastian Köcher <git@kchr.de>

proc-macro-error, proc-macro-error-attr
  Copyright (c) 2019-2020 CreepySkeleton

proc-macro2
  Authors: David Tolnay <dtolnay@gmail.com>, Alex Crichton <alex@alexcrichton.com>

psm
  Copyright © 2018, Simonas Kazlauskas

quick-error
  Copyright (c) 2015 The quick-error Developers

quick-xml
  Copyright (c) 2016 Johann Tuffe

rand
  Copyrights in the Rand project are retained by their contributors.
  Copyright 2018 Developers of the Rand project
  Copyright (c) 2014 The Rust Project Developers

rand_core
  Copyrights in the Rand project are retained by their contributors.
  Copyright (c) 2018-2026 The Rand Project Developers

raw-window-handle
  Copyright (c) 2019 Osspial

reqwest
  Copyright (c) 2016-2026 Sean McArthur

rfd
  Copyright (c) 2022 Bartłomiej Maryńczak

rustc-hash
  Author: The Rust Project Developers

rustix
  Copyrights in the `rustix` project are retained by their contributors.

rustls-pki-types
  Copyright (c) 2023 Dirkjan Ochtman <dirkjan@ochtman.nl>

rustls-platform-verifier
  Copyright (c) 2022 1Password

same-file, winapi-util
  Copyright (c) 2017 Andrew Gallant

schannel
  Copyright (c) 2015 steffengy

schemars, schemars_derive
  Copyright (c) 2019 Graham Esau

scopeguard
  Copyright (c) 2016-2019 Ulrik Sverdrup "bluss" and scopeguard developers

secrecy
  Copyright (c) 2019-2024 iqlusion

secret-service
  Copyright (c) 2025 secret-service Developers

security-framework, security-framework-sys
  Copyright (c) 2015 Steven Fackler

serde, serde_core, serde_derive, serde_derive_internals
  Authors: Erick Tryzelaar <erick.tryzelaar@gmail.com>, David Tolnay <dtolnay@gmail.com>

serde-value
  Copyright (c) 2016 arcnmx

serde_with
  Copyright (c) 2015
  Authors: Jonas Bushart, Marcin Kaźmierczak

serde_with_macros
  Copyright (c) 2015
  Author: Jonas Bushart

serde_yaml_ng
  Copyright 2024 Antoine Catton
  Copyright 2016-2024 David Tolnay

serialize-to-javascript, serialize-to-javascript-impl
  Copyright (c) 2021 Chip Reed

servo_arc
  Author: The Servo Project Developers

sha1, sha2 0.11.1
  Copyright (c) 2016-2026 The RustCrypto Project Developers
  Copyright (c) 2016 Artyom Pavlov
  Copyright (c) 2009-2013 Mozilla Foundation
  Copyright (c) 2006-2009 Graydon Hoare

sha2 0.10.9
  Copyright (c) 2006-2009 Graydon Hoare
  Copyright (c) 2009-2013 Mozilla Foundation
  Copyright (c) 2016 Artyom Pavlov

shared_library
  Copyright (c) 2017 Pierre Krieger

shell-words
  Copyright (c) 2016 Tomasz Miąsko

signal-hook-registry
  Copyright (c) 2017 tokio-jsonrpc developers

simd-adler32
  Copyright (c) [2021] [Marvin Countryman]

simdutf8
  Author: Hans Kratz <hans@appfour.com>

siphasher
  Author: Frank Denis <github@pureftpd.org>

slab
  Copyright (c) 2019 Carl Lerche

smallvec
  Copyright (c) 2018 The Servo Project Developers

softbuffer
  Copyright 2022 Kirill Chibisov

stable_deref_trait
  Copyright (c) 2017 Robert Grosse

strsim
  Copyright (c) 2015 Danny Guo
  Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
  Copyright (c) 2018 Akash Kurdekar

symlink
  Copyright (c) 2014 Chris Morgan and the Teepee project developers

synstructure
  Copyright 2016 Nika Layzell

system-configuration, system-configuration-sys
  Copyright (c) 2024 Mullvad VPN AB

tar
  Copyright (c) The tar-rs Project Contributors

tauri, tauri-codegen, tauri-macros, tauri-plugin-clipboard-manager, tauri-plugin-dialog,
tauri-plugin-fs, tauri-plugin-opener, tauri-runtime,
tauri-runtime-wry, tauri-utils
  Copyright (c) 2017 - Present Tauri Apps Contributors

tempfile
  Copyright (c) 2015 Steven Allen

tendril
  Copyright (c) 2015 Keegan McAllister

tiff
  Copyright (c) 2018 PistonDevelopers

time, time-core, time-macros
  Copyright (c) Jacob Pratt et al.

tokio, tokio-util
  Copyright (c) Tokio Contributors

tokio-macros
  Copyright (c) 2019 Yoshua Wuyts
  Copyright (c) Tokio Contributors

tokio-rustls
  Copyright (c) 2017 quininer kel

tokio-tungstenite
  Copyright (c) 2017 Daniel Abramov
  Copyright (c) 2017 Alexey Galakhov

tower, tower-layer, tower-service
  Copyright (c) 2019 Tower Contributors

tower-http
  Copyright (c) 2019-2021 Tower Contributors

tracing, tracing-appender, tracing-attributes, tracing-core, tracing-log, tracing-subscriber
  Copyright (c) 2019 Tokio Contributors

tree_magic_mini
  Copyright (c) 2017 Aaron Hancock

try-lock
  Copyright (c) 2018-2023 Sean McArthur
  Copyright (c) 2016 Alex Crichton

ts-rs, ts-rs-macros
  Author: Moritz Bischof <moritz.bischof1@gmail.com>

tungstenite
  Copyright (c) 2017 Alexey Galakhov
  Copyright (c) 2016 Jason Housley

typed-path
  Author: Chip Senkbeil <chip@senkbeil.org>

typenum
  Copyright (c) 2014 Paho Lurie-Gregg

urlpattern
  Copyright (c) 2021 the Deno authors

uuid
  Copyright (c) 2014 The Rust Project Developers
  Copyright (c) 2018 Ashley Mannix, Christopher Armstrong, Dylan DPC, Hunar Roop Kahlon

want
  Copyright (c) 2018-2019 Sean McArthur

wayland-backend, wayland-client, wayland-protocols, wayland-protocols-wlr, wayland-scanner,
wayland-sys
  Copyright (c) 2015 Elinor Berger

web-time
  Copyright (c) 2023 dAxpeDDa

webkit2gtk
  Copyright (c) 2016 Boucher, Antoni <bouanto@zoho.com>
  Copyright (c) 2017-2021, The Gtk-rs Project Developers.
  Copyright (c) 2021, Tauri Programme within The Commons Conservancy

webkit2gtk-sys
  Copyright (c) 2016 Boucher, Antoni <bouanto@zoho.com>

weezl
  Copyright (c) HeroicKatora 2020

winapi
  Copyright (c) 2015-2018 The winapi-rs Developers

window-vibrancy
  Copyright (c) 2020-2022 Tauri Programme within The Commons Conservancy

windows, windows-collections, windows-core, windows-future, windows-implement,
windows-interface, windows-link, windows-numerics, windows-registry, windows-result,
windows-strings, windows-sys, windows-targets, windows-threading, windows-version,
windows_x86_64_msvc
  Copyright (c) Microsoft Corporation.

winreg
  Copyright (c) 2015 Igor Shaula

wl-clipboard-rs
  Copyright (c) 2019 Ivan Molodetskikh

wry
  Copyright (c) 2020-2023 Ngo Iok Ui & Tauri Programme within The Commons Conservancy

x11, x11-dl
  Authors: daggerbot <daggerbot@gmail.com>, Erle Pereira <erle@erlepereira.com>, AltF02 <contact@altf2.dev>

x11rb, x11rb-protocol
  Copyright 2019 x11rb Contributers

zbus, zbus_macros, zbus_names, zvariant, zvariant_derive
  Copyright (c) 2024 Zeeshan Ali Khan & zbus contributors

zcheapstr
  Copyright (c) 2026 Zeeshan Ali Khan & zcheapstr contributors

zerocopy, zerocopy-derive
  Copyright 2023 The Fuchsia Authors

zeroize
  Copyright (c) 2018-2026 The RustCrypto Project Developers

zip
  Copyright (c) 2014 Mathijs van de Nes

zune-core, zune-jpeg
  Copyright (c) zune-image developers

zvariant_utils
  Authors: Zeeshan Ali Khan <zeeshanak@gnome.org>, turbocooler <turbocooler@cocaine.ninja>

blocking, cargo-platform, libappindicator-sys, objc2-app-kit, objc2-core-foundation,
objc2-core-graphics, objc2-core-services, objc2-foundation, objc2-quartz-core,
objc2-web-kit, pin-project, pin-project-internal, pin-project-lite, serde-saphyr,
serde_json, webview2-com, webview2-com-macros, webview2-com-sys, winnow
  (the crate states no copyright line and no author)
```

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

### Crates under Apache-2.0

These crates are under the Apache License 2.0, or offer it beside a BSD license. Its text is in this
file. The copyright notices follow as each crate's license
files state them; `tao`'s comes from its SPDX file, and where a crate states none its authors
follow from `Cargo.toml`. `dpi` puts its own code under Apache-2.0 and its copy of
rust-lang/libm under MIT, listed above. For `ring`, see
[Other notices inside crates](#other-notices-inside-crates).

```text
backon
  Copyright 2021 Datafuse Labs

gethostname
  Author: Sebastian Wiesner <sebastian@swsnr.de>

k8s-openapi
  Author: Arnav Singh <me@arnavion.dev>

kube, kube-client, kube-core, kube-runtime
  Authors: clux <sszynrae@gmail.com>, Natalie Klestrup Röijezon <nat@nullable.se>, kazk <kazk.dev@gmail.com>

moxcms, pxfm
  Copyright 2024 Radzivon Bartoshyk

serial2
  Copyright 2021, Maarten de Vries <maarten@de-vri.es>

sync_wrapper
  Author: Actyx AG <developer@actyx.io>

tao
  Copyright 2021-2023, The Tauri Programme in the Commons Conservancy
  Authors: Tauri Programme within The Commons Conservancy, The winit contributors

dpi
  (the crate states no copyright line and no author)
```

### Crates under BSD-3-Clause

These crates are under the BSD 3-Clause License. `brotli` is under BSD-3-Clause and MIT
together; its MIT notice is listed above. `encoding_rs` is under MIT, listed above, except for
its data from the WHATWG Encoding Standard. `alloc-stdlib` ships no license file, so its author
follows from `Cargo.toml`. The license text after the notices is the same for every crate.

```text
alloc-no-stdlib, brotli, brotli-decompressor
  Copyright (c) 2016 Dropbox, Inc.

alloc-stdlib
  Author: Daniel Reiter Horn <danielrh@dropbox.com>

encoding_rs (data from the WHATWG Encoding Standard)
  Copyright © WHATWG (Apple, Google, Mozilla, Microsoft).

subtle
  Copyright (c) 2016-2017 Isis Agora Lovecruft, Henry de Valence. All rights reserved.
  Copyright (c) 2016-2024 Isis Agora Lovecruft. All rights reserved.
```

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

### Crates under ISC

These crates are under the ISC License. The license files of `untrusted` and `rustls-webpki`
read "the authors disclaim" and "the authors be liable" where the text below reads "the author";
the terms are the same. The `ring` entry gathers its `LICENSE-other-bits` and the ISC headers of
its source files; for the rest of `ring`, see
[Other notices inside crates](#other-notices-inside-crates).

```text
inotify, inotify-sys
  Copyright (c) Hanno Braun and contributors

libloading
  Copyright © 2015, Simonas Kazlauskas

ring
  Copyright 2015-2025 Brian Smith.
  Copyright 2016 David Judd.
  Copyright 2016 Simon Sapin.
  Copyright 2018 Trent Clarke.
  Copyright (c) 2014, Google Inc.
  Copyright (c) 2014, 2015, Google Inc.
  Copyright (c) 2015, Google Inc.
  Copyright (c) 2016, Google Inc.
  Copyright (c) 2019, Google Inc.
  Copyright (c) 2014, Intel Corporation.

rustls-webpki
  Copyright 2015 Brian Smith.

untrusted
  Copyright 2015-2016 Brian Smith.
```

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

### Crates under Unicode-3.0

These crates are under the Unicode License v3. `unicode-ident` is under MIT, listed above, for
its code, and under Unicode-3.0 for the Unicode data in it.

```text
icu_collections, icu_locale_core, icu_normalizer, icu_normalizer_data, icu_properties,
icu_properties_data, icu_provider, litemap, potential_utf, tinystr, writeable, yoke,
yoke-derive, zerofrom, zerofrom-derive, zerotrie, zerovec, zerovec-derive
  Copyright © 2020-2024 Unicode, Inc.
  Portions of ICU4X may have been adapted from ICU4C and/or ICU4J.
  ICU 1.8.1 to ICU 57.1 © 1995-2016 International Business Machines Corporation and others.

unicode-ident
  Copyright © 1991-2023 Unicode, Inc.
```

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

### Crates under Zlib

`foldhash` (0.1.5 and 0.2.0) is under the zlib License:

```text
Copyright (c) 2024 Orson Peters

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use of
this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
    that you wrote the original software. If you use this software in a product,
    an acknowledgment in the product documentation would be appreciated but is
    not required.

2. Altered source versions must be plainly marked as such, and must not be
    misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

### Crates under MPL-2.0

These crates are under the Mozilla Public License 2.0, which applies file by file to their
source. SkoposIDE uses them unmodified. Their source code is available from crates.io at the
addresses below. Their license files carry no copyright line, so their authors follow from
`Cargo.toml`.

```text
cssparser
  Author: Simon Sapin <simon.sapin@exyr.org>
  Source: https://crates.io/crates/cssparser/0.37.0

cssparser-macros
  Author: Simon Sapin <simon.sapin@exyr.org>
  Source: https://crates.io/crates/cssparser-macros/0.7.1

dtoa-short
  Author: Xidorn Quan <me@upsuper.org>
  Source: https://crates.io/crates/dtoa-short/0.3.5

option-ext
  Author: Simon Ochsenreither <simon@ochsenreither.de>
  Source: https://crates.io/crates/option-ext/0.2.0

selectors
  Author: The Servo Project Developers
  Source: https://crates.io/crates/selectors/0.38.0
```

```text
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in 
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

### Other notices inside crates

- **ring** 0.17.14 (https://github.com/briansmith/ring) is under the ISC License for its own
  code and the code it took from BoringSSL under ISC, and under Apache-2.0 for the code it took
  from BoringSSL and fiat-crypto under Apache-2.0. Its ISC copyright notices are listed under
  [Crates under ISC](#crates-under-isc), from its `LICENSE-other-bits` and from the ISC headers
  of its source files. Its Apache-2.0 files carry the notices of The OpenSSL Project Authors,
  The BoringSSL Authors, Intel Corporation, CloudFlare, Oracle and ARM, and its
  `third_party/fiat/LICENSE` states "Copyright 2015-2020 the fiat-crypto authors (see the
  AUTHORS file)". Its copy of once_cell is under MIT; once_cell is listed under
  [Crates under MIT](#crates-under-mit). The Go and Chromium licenses in its
  `LICENSE-BoringSSL` cover BoringSSL's test and build scripts, which `ring` does not compile.
- **webview2-com-sys** 0.39.1 carries Microsoft's WebView2 loader (`WebView2LoaderStatic.lib`,
  from the WebView2 SDK), which the Windows build links statically. The crate is under MIT and
  ships no license text for the loader; the loader is under the license of Microsoft's WebView2
  SDK.
- **atomic-waker** and **futures-lite** carry code from futures-rs, and **parking** code from
  the Rust standard library. Their `LICENSE-THIRD-PARTY` files offer that code under MIT or
  Apache-2.0; SkoposIDE takes MIT, and the notices are listed under
  [Crates under MIT](#crates-under-mit).
- **crossbeam-channel**'s `LICENSE-THIRD-PARTY` covers tests ported from Go and from the Rust
  standard library (CC-BY-3.0, BSD-3-Clause, MIT and Apache-2.0). The tests are not compiled
  into the app.
- **security-framework**'s `THIRD_PARTY` file covers documentation adapted from Apple's
  Security framework under the Apple Public Source License 2.0. That documentation lives in
  source comments and is not compiled into the app.
- **libdbus-sys** links the system's libdbus. Its vendored copy of dbus is built only with its
  `vendored` feature, which the app does not enable.

### Crates that need no notice

- **ryu** (Apache-2.0 or BSL-1.0, SkoposIDE takes BSL-1.0; author David Tolnay),
  **clipboard-win** and **error-code** (BSL-1.0; author Douman): the Boost Software License
  asks for its notice in copies of the source, not in machine-executable object code.
- **constant_time_eq** (CC0-1.0, MIT-0 or Apache-2.0, SkoposIDE takes CC0-1.0; author Cesar
  Eduardo Barros), **dunce** (the same choice; author Kornel) and **notify** (CC0-1.0; authors
  Félix Saparelli, Daniel Faust and Aron Heinecke): CC0 waives copyright and asks for
  no notice.

They are listed so the list is complete.

## Apache License 2.0

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
