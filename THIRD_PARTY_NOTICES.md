# Third-party notices

The license stated for each component below governs that component and Caxri's modifications to it. Those third-party terms are not replaced by the license applied to Caxri as a whole.

## anti-slop

Caxri vendors the generic anti-slop Oxlint plugin as contributor tooling. The source was copied from upstream commit [`6d538555`](https://github.com/dmmulroy/anti-slop/commit/6d538555cb151d4121ed51a27db81890eacf8ae9); it is not part of the product runtime.

Copyright (c) 2026 Dillon Mulroy. Licensed under the MIT License. The vendored license text is in `licenses/ANTI_SLOP_LICENSE.txt`; the upstream source is <https://github.com/dmmulroy/anti-slop>.

## Patched dependencies

### app-builder-lib 26.15.3

Caxri applies `patches/app-builder-lib.patch` to the published `app-builder-lib` package. The patch removes pnpm's unsupported `--loglevel=error` argument from the production dependency collector while retaining its remaining arguments.

The upstream patch base is [`electron-builder@26.15.3`](https://github.com/electron-userland/electron-builder/tree/electron-builder%4026.15.3/packages/app-builder-lib). Licensed under the MIT License. The complete license text is in `licenses/APP_BUILDER_LIB_LICENSE.txt`.

### braces 3.0.3

Caxri applies `patches/braces@3.0.3.patch` to the published `braces` package. The patch is the exact fix from [upstream PR #72](https://github.com/micromatch/braces/pull/72): it limits recursive parsing, compilation, expansion, and stringification depth, and detects cycles while walking parent queues.

The upstream patch base is [`braces` 3.0.3](https://github.com/micromatch/braces/tree/3.0.3). Copyright (c) 2014-present, Jon Schlinkert. Licensed under the MIT License. The complete license text is in `licenses/BRACES_LICENSE.txt`.

### node-forge 1.4.0

Caxri applies `patches/node-forge@1.4.0.patch` to the published `node-forge` package. The patch rejects extra children inside an RSA PKCS#1 v1.5 `DigestAlgorithm` sequence instead of validating only the outer `DigestInfo` element count.

The upstream patch base is [`node-forge` v1.4.0](https://github.com/digitalbazaar/forge/tree/v1.4.0). Caxri elects the BSD 3-Clause option offered by node-forge's dual license. Copyright (c) 2010, Digital Bazaar, Inc. The selected complete license text is in `licenses/NODE_FORGE_BSD_3_CLAUSE_LICENSE.txt`.

### node-pty 1.1.0

Caxri applies `patches/node-pty@1.1.0.patch` to the published `node-pty` package. The patch adds Unix PTY write-completion, input quiesce, and resume controls, updates the public types, and restores the executable bit on the prebuilt `spawn-helper` after pnpm patch extraction. `scripts/node-pty-layout.ts` also adapts node-pty's native module load order so preparation and packaged staging select the same layout.

The upstream patch base is [`node-pty` v1.1.0](https://github.com/microsoft/node-pty/tree/v1.1.0), including the [native load-order source](https://github.com/microsoft/node-pty/blob/v1.1.0/src/utils.ts). Licensed under the MIT License. The complete license text is in `licenses/NODE_PTY_LICENSE.txt`.

### react-native-webview 13.16.1

Caxri applies `patches/react-native-webview.patch` to the published `react-native-webview` package. The patch blocks Android WebView network loads immediately after WebView construction, before configuration callbacks or content loading can run.

The upstream patch base is [`react-native-webview` v13.16.1](https://github.com/react-native-webview/react-native-webview/tree/v13.16.1). Copyright (c) 2015-present, Facebook, Inc. Licensed under the MIT License. The complete license text is in `licenses/REACT_NATIVE_WEBVIEW_LICENSE.txt`.

### sonner 2.0.8

Caxri applies `patches/sonner.patch` to the published `sonner` package's distributed JavaScript and type declarations. The patch preserves timer accounting when an infinite-duration toast is paused and lets the host suppress focus restoration while another surface owns focus.

The upstream patch base is the package's published commit [`ecce1841`](https://github.com/emilkowalski/sonner/tree/ecce1841c55e4a72dfe139a8992b56498660125e). Copyright (c) 2023 Emil Kowalski. Licensed under the MIT License. The complete license text is in `licenses/SONNER_LICENSE.txt`.

### @xterm/addon-serialize 0.15.0-beta.301

Caxri applies `patches/xterm-addon-serialize.patch` to the published `@xterm/addon-serialize` package's TypeScript source and distributed JavaScript. The patch bounds serialization to visible terminal columns and restores an absolute cursor column correctly after xterm's pending-wrap state.

The upstream patch base is the package's published commit [`c58ea363`](https://github.com/xtermjs/xterm.js/tree/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/addons/addon-serialize). Licensed under the MIT License. The complete license text is in `licenses/XTERM_ADDON_SERIALIZE_LICENSE.txt`.

## xterm.js

Caxri uses `@xterm/xterm` 6.1.0-beta.304 for terminal rendering. The mobile terminal build embeds the package's compiled JavaScript and CSS directly in its offline WebView document.

The published package corresponds to commit [`c58ea363`](https://github.com/xtermjs/xterm.js/tree/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2). Licensed under the MIT License. The complete license text is in `licenses/XTERM_LICENSE.txt`.

## Anthropic Claude Agent SDK

Caxri bundles transformed JavaScript from `@anthropic-ai/claude-agent-sdk` 0.3.296 in the Server to provide Claude Agent Chat. Caxri does not bundle the native Claude Code executable; each user supplies and authenticates their own local installation. Public Source Maps remove the SDK package's `sourcesContent` while retaining mappings, because the published package does not grant an open-source license for redistributing its complete source through a Source Map.

Copyright (c) Anthropic PBC. All rights reserved. Use is subject to Anthropic's [legal agreements for Claude Code](https://code.claude.com/docs/en/legal-and-compliance), including the [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) where applicable. The package notice is preserved verbatim in `licenses/ANTHROPIC_CLAUDE_AGENT_SDK_LICENSE.txt`. That notice and these links do not grant rights beyond Anthropic's terms; public binary redistribution still requires confirmation under those terms.

## LiteLLM model pricing data

`apps/server/src/domains/usage/bundled-prices.generated.json` is a generated projection of LiteLLM's community-maintained [`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json). Caxri's generator filters the source to model families reported by its Agent providers, projects the relevant token price, cache price, long-context tier, and service-tier fields, and sorts the resulting entries for an offline fallback snapshot.

The upstream source is <https://github.com/BerriAI/litellm>. Content outside LiteLLM's separately licensed `enterprise/` directory is licensed under the MIT License. Copyright (c) 2023 Berri AI. The complete applicable license text is in `licenses/LITELLM_LICENSE.txt`.

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

The `@yutengjing/vscode-icons` source code is Copyright (c) 2026 YuTengjing and licensed under the MIT License. The complete source-code license text is in `licenses/VSCODE_ICONS_SOURCE_LICENSE.txt`; the fixed published source is commit [`442978eb`](https://github.com/tjx666/vscode-icons/tree/442978eb742d961cd0522480607cb683a48f1202).

The bundled icon assets are (c) the vscode-icons project, licensed under the Creative Commons Attribution-ShareAlike 4.0 International License. The vendored license text is in `licenses/VSCODE_ICONS_ASSETS_LICENSE.txt`; the upstream source is <https://github.com/vscode-icons/vscode-icons>.

## VS Code Codicons

Caxri includes the `archive`, `diff-multiple`, `discard`, `repo`, `sync`, and `worktree` glyphs from Microsoft's VS Code Codicons. Caxri converted the upstream SVG glyphs into inline React components; the component wrappers and `currentColor` integration are Caxri modifications.

The upstream source is <https://github.com/microsoft/vscode-codicons>. Licensed under the Creative Commons Attribution 4.0 International License (<https://creativecommons.org/licenses/by/4.0/>). The complete license text and warranty disclaimer are in `licenses/VSCODE_CODICONS_LICENSE.txt`.

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

## vscode-languagedetection

Caxri bundles the language detection model and its loader from Microsoft's `@vscode/vscode-languagedetection` package to choose the language of an untitled Editor buffer, as VS Code does. The model is loaded from local packaged assets, never fetched remotely, and runs on the CPU TensorFlow.js backend.

Copyright (c) Microsoft Corporation. Licensed under the MIT License. The vendored license text is in `licenses/VSCODE_LANGUAGEDETECTION_LICENSE.txt`; the upstream source is <https://github.com/microsoft/vscode-languagedetection>. The model is trained by the guesslang project, <https://github.com/yoeo/guesslang>.

## PDF.js

Caxri bundles PDF.js from the `pdfjs-dist` package to render PDF files in the Preview, along with the built-in data PDF.js reads while parsing: Adobe CMaps, two Foxit standard fonts, and WebAssembly image decoders. These data files are inlined into the packaged Renderer and loaded locally, never fetched remotely. The PDF Preview stylesheet also copies a subset of the rules in PDF.js's `web/pdf_viewer.css`.

- PDF.js, including the rules adapted from `web/pdf_viewer.css`, is Copyright Mozilla Foundation and licensed under the Apache License 2.0. The vendored license text is in `licenses/PDFJS_LICENSE.txt`; the upstream source is <https://github.com/mozilla/pdf.js>.
- The Adobe CMaps (`cmaps/*.bcmap`) are Copyright 1990-2009 Adobe Systems Incorporated and licensed under the BSD 3-Clause License. The vendored license text is in `licenses/ADOBE_CMAPS_LICENSE.txt`; the upstream source is <https://github.com/adobe-type-tools/cmap-resources>.
- The Foxit standard fonts `FoxitSymbol.pfb` and `FoxitDingbats.pfb` are Copyright 2014 PDFium Authors and licensed under the BSD 3-Clause License. The vendored license text is in `licenses/FOXIT_FONTS_LICENSE.txt`; the upstream source is <https://pdfium.googlesource.com/pdfium/>.
- The JBIG2 decoder (`wasm/jbig2.wasm`) is built from the PDFium JBIG2 decoder, Copyright 2014 The PDFium Authors, under the BSD 3-Clause and Apache 2.0 terms in `licenses/JBIG2_LICENSE.txt`. Its PDF.js WebAssembly wrapper is Copyright 2026 Mozilla Foundation and licensed under the Apache License 2.0; the vendored license text is in `licenses/PDFJS_JBIG2_LICENSE.txt`.
- The JPEG 2000 decoder (`wasm/openjpeg.wasm`) is built from OpenJPEG, Copyright (c) 2002-2014 Universite catholique de Louvain (UCL), Belgium, and other contributors, licensed under the BSD 2-Clause License. The vendored license text is in `licenses/OPENJPEG_LICENSE.txt`; the upstream source is <https://github.com/uclouvain/openjpeg>. Its PDF.js WebAssembly wrapper is Copyright (c) 2024 Mozilla Foundation and licensed under the BSD 2-Clause License; the vendored license text is in `licenses/PDFJS_OPENJPEG_LICENSE.txt`.
