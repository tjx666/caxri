# Third-party notices

## anti-slop

Caxri vendors the generic anti-slop Oxlint plugin as contributor tooling. The source was copied from upstream commit [`6d538555`](https://github.com/dmmulroy/anti-slop/commit/6d538555cb151d4121ed51a27db81890eacf8ae9); it is not part of the product runtime.

Copyright (c) 2026 Dillon Mulroy. Licensed under the MIT License. The vendored license text is in `licenses/ANTI_SLOP_LICENSE.txt`; the upstream source is <https://github.com/dmmulroy/anti-slop>.

## Dracula Theme

Caxri's default semantic color tokens are derived from the official Dracula Theme palette.

Copyright (c) 2023 Dracula Theme. Licensed under the MIT License. The vendored license text is in `licenses/DRACULA_LICENSE.txt`; the upstream source is <https://github.com/dracula/dracula-theme/blob/main/LICENSE>.

## JetBrains Mono

Caxri bundles JetBrains Mono Regular, Bold, Italic, and Bold Italic for consistent terminal text rendering.

Copyright 2020 The JetBrains Mono Project Authors. Licensed under the SIL Open Font License 1.1. The vendored license text is in `licenses/JETBRAINS_MONO_OFL.txt`; the upstream source is <https://github.com/JetBrains/JetBrainsMono>.

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
