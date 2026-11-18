# Third-party notices

SkoposIDE is new code, written for this project. Parts of its logic are adapted from the
open-source projects below, whose license requires this notice to stay with the code.
The app also bundles fonts, icons and npm packages. Their sections below, from
[Fonts](#fonts) on, carry the copyright notices and license texts that their licenses ask
every copy to keep. The Rust crates that the app links, pinned in `Cargo.lock`, are not
listed here yet.

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
- License: Apache-2.0, the license in `LICENSE`, chosen of the two it offers (Apache-2.0 and
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
