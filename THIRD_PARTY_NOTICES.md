# Third-party notices

## anti-slop

Caxri vendors the generic anti-slop Oxlint plugin as contributor tooling. The source was copied from upstream commit [`6d538555`](https://github.com/dmmulroy/anti-slop/commit/6d538555cb151d4121ed51a27db81890eacf8ae9); it is not part of the product runtime.

Copyright (c) 2026 Dillon Mulroy. Licensed under the MIT License. The vendored license text is in `licenses/ANTI_SLOP_LICENSE.txt`; the upstream source is <https://github.com/dmmulroy/anti-slop>.

## Dracula Theme

Caxri's default semantic color tokens are derived from the official Dracula Theme palette.

Copyright (c) 2023 Dracula Theme. Licensed under the MIT License. The vendored license text is in `licenses/DRACULA_LICENSE.txt`; the upstream source is <https://github.com/dracula/dracula-theme/blob/main/LICENSE>.

## Built-in editor themes

Caxri includes normalized app, editor, and Terminal palettes derived from several open-source editor themes:

- Monokai, Solarized Dark, Solarized Light, and VS Code Dark+ use theme definitions from Microsoft Visual Studio Code. Copyright (c) 2015-present Microsoft Corporation, licensed under the MIT License. The vendored license text is in `licenses/VSCODE_THEMES_LICENSE.txt`; the upstream source is <https://github.com/microsoft/vscode>.
- Solarized Dark and Solarized Light are based on Ethan Schoonover's Solarized palette. Copyright (c) 2011 Ethan Schoonover, licensed under the MIT License. The vendored license text is in `licenses/SOLARIZED_LICENSE.txt`; the upstream source is <https://github.com/altercation/solarized>.
- One Dark Pro is Copyright (c) 2013-2022 Binaryify, licensed under the MIT License. The vendored license text is in `licenses/ONEDARK_PRO_LICENSE.txt`; the upstream source is <https://github.com/Binaryify/OneDark-Pro>.
- Tokyo Night is Copyright (c) 2018-present Enkia, licensed under the MIT License. The vendored license text is in `licenses/TOKYO_NIGHT_LICENSE.txt`; the upstream source is <https://github.com/tokyo-night/tokyo-night-vscode-theme>.
- Oscura Midnight uses the Narative/Fey editor palette and the matching Ghostty port for ANSI colors. Copyright (c) 2025 Narative, licensed under the MIT License. The vendored license text is in `licenses/OSCURA_LICENSE.txt`; the upstream sources are <https://github.com/narative/oscura> and <https://github.com/jshmllr/oscura>.

## JetBrains Mono

Caxri bundles JetBrains Mono Regular, Bold, Italic, and Bold Italic for consistent terminal text rendering; the mobile app bundles the Regular and Bold faces.

Copyright 2020 The JetBrains Mono Project Authors. Licensed under the SIL Open Font License 1.1. The vendored license text is in `licenses/JETBRAINS_MONO_OFL.txt`; the upstream source is <https://github.com/JetBrains/JetBrainsMono>.

## Noto Sans Symbols 2

The Caxri mobile app bundles a subset of Noto Sans Symbols 2 (arrows, technical symbols, geometric shapes, and dingbats) as a terminal fallback for glyphs JetBrains Mono lacks, such as the media-control arrows Agent CLIs print.

Copyright 2022 The Noto Project Authors. Licensed under the SIL Open Font License 1.1. The vendored license text is in `licenses/NOTO_SANS_SYMBOLS_OFL.txt`; the upstream source is <https://github.com/notofonts/symbols>.

## Nerd Fonts Symbols

Caxri bundles Symbols Nerd Font Mono as a terminal fallback for Powerline and private-use glyphs.

Copyright (c) 2014 Ryan L McIntyre. Licensed under the MIT License. The vendored license text is in `licenses/NERD_FONTS_LICENSE.txt`; the upstream source is <https://github.com/ryanoasis/nerd-fonts>.

## vscode-icons

Caxri bundles the file and folder icon set from the `@yutengjing/vscode-icons` package (a maintained standalone port of the `vscode-icons` VS Code extension icon data) for the Files view, so file and folder icons match the look of VS Code's vscode-icons extension. The full icon set is emitted into the Renderer build as individual SVG assets (any file or folder name can appear in a user's project at runtime); icons are loaded from local packaged assets, never fetched remotely.

The `@yutengjing/vscode-icons` source code is licensed under the MIT License; the upstream source is <https://github.com/tjx666/vscode-icons>.

The bundled icon assets are (c) the vscode-icons project, licensed under the Creative Commons Attribution-ShareAlike 4.0 International License. The vendored license text is in `licenses/VSCODE_ICONS_ASSETS_LICENSE.txt`; the upstream source is <https://github.com/vscode-icons/vscode-icons>.

## Lobe Icons

Caxri bundles Claude Code, Codex, Grok, and OpenCode SVG assets from `@lobehub/icons-static-svg`. Color assets preserve their authored palette; monochrome assets are rendered as theme-colored masks.

Copyright (c) 2023 LobeHub. Licensed under the MIT License. The vendored license text is in `licenses/LOBEHUB_ICONS_LICENSE.txt`; the upstream source is <https://github.com/lobehub/lobe-icons>.

## Primer Octicons

Caxri bundles the `mark-github` icon path from Primer Octicons as its GitHub mark, including the site icon ahead of GitHub links in Agent Chat.

Copyright (c) GitHub Inc. Licensed under the MIT License. The vendored license text is in `licenses/PRIMER_OCTICONS_LICENSE.txt`; the upstream source is <https://github.com/primer/octicons>.

## ripgrep / vscode-ripgrep

Caxri bundles the platform-specific ripgrep executable distributed by `@vscode/ripgrep-universal` for fast Project file discovery.

ripgrep is Copyright (c) 2015 Andrew Gallant and licensed under the MIT License. The vendored license text is in `licenses/RIPGREP_LICENSE.txt`; the upstream source is <https://github.com/BurntSushi/ripgrep>.

vscode-ripgrep is Copyright (c) Microsoft Corporation and licensed under the MIT License. The vendored license text is in `licenses/VSCODE_RIPGREP_LICENSE.txt`; the upstream source is <https://github.com/microsoft/vscode-ripgrep>.

## PDF.js

Caxri bundles PDF.js from the `pdfjs-dist` package to render PDF files in the Preview, along with the built-in data PDF.js reads while parsing: Adobe CMaps, two Foxit standard fonts, and WebAssembly image decoders. These data files are inlined into the packaged Renderer and loaded locally, never fetched remotely. The PDF Preview stylesheet also copies a subset of the rules in PDF.js's `web/pdf_viewer.css`.

- PDF.js, including the rules adapted from `web/pdf_viewer.css`, is Copyright Mozilla Foundation and licensed under the Apache License 2.0. The vendored license text is in `licenses/PDFJS_LICENSE.txt`; the upstream source is <https://github.com/mozilla/pdf.js>.
- The Adobe CMaps (`cmaps/*.bcmap`) are Copyright 1990-2009 Adobe Systems Incorporated and licensed under the BSD 3-Clause License. The vendored license text is in `licenses/ADOBE_CMAPS_LICENSE.txt`; the upstream source is <https://github.com/adobe-type-tools/cmap-resources>.
- The Foxit standard fonts `FoxitSymbol.pfb` and `FoxitDingbats.pfb` are Copyright 2014 PDFium Authors and licensed under the BSD 3-Clause License. The vendored license text is in `licenses/FOXIT_FONTS_LICENSE.txt`; the upstream source is <https://pdfium.googlesource.com/pdfium/>.
- The JBIG2 decoder (`wasm/jbig2.wasm`) is built from the PDFium JBIG2 decoder, Copyright 2014 The PDFium Authors, under the BSD 3-Clause and Apache 2.0 terms in `licenses/JBIG2_LICENSE.txt`. Its PDF.js WebAssembly wrapper is Copyright 2026 Mozilla Foundation and licensed under the Apache License 2.0; the vendored license text is in `licenses/PDFJS_JBIG2_LICENSE.txt`.
- The JPEG 2000 decoder (`wasm/openjpeg.wasm`) is built from OpenJPEG, Copyright (c) 2002-2014 Universite catholique de Louvain (UCL), Belgium, and other contributors, licensed under the BSD 2-Clause License. The vendored license text is in `licenses/OPENJPEG_LICENSE.txt`; the upstream source is <https://github.com/uclouvain/openjpeg>. Its PDF.js WebAssembly wrapper is Copyright (c) 2024 Mozilla Foundation and licensed under the BSD 2-Clause License; the vendored license text is in `licenses/PDFJS_OPENJPEG_LICENSE.txt`.
