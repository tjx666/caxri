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

## ripgrep / vscode-ripgrep

Caxri bundles the platform-specific ripgrep executable distributed by `@vscode/ripgrep-universal` for fast Project file discovery.

ripgrep is Copyright (c) 2015 Andrew Gallant and licensed under the MIT License. The vendored license text is in `licenses/RIPGREP_LICENSE.txt`; the upstream source is <https://github.com/BurntSushi/ripgrep>.

vscode-ripgrep is Copyright (c) Microsoft Corporation and licensed under the MIT License. The vendored license text is in `licenses/VSCODE_RIPGREP_LICENSE.txt`; the upstream source is <https://github.com/microsoft/vscode-ripgrep>.
