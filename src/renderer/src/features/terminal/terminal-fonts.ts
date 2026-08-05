export const TERMINAL_FONT_FAMILY =
    '"Caxri JetBrains Mono", "Caxri Nerd Symbols", SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const BUNDLED_FONT_REQUESTS = [
    ['400 13px "Caxri JetBrains Mono"', 'Caxri'],
    ['700 13px "Caxri JetBrains Mono"', 'Caxri'],
    ['italic 400 13px "Caxri JetBrains Mono"', 'Caxri'],
    ['italic 700 13px "Caxri JetBrains Mono"', 'Caxri'],
    ['400 13px "Caxri Nerd Symbols"', '\ue0b0\uf17c'],
] as const;

let fontLoad: Promise<void> | undefined;

/**
 * Loads bundled faces before xterm measures cells, following Kero's font cascade.
 * https://github.com/egoist/kero/blob/main/kero/TerminalFont.swift
 */
export function loadTerminalFonts(): Promise<void> {
    fontLoad ??= Promise.all(
        BUNDLED_FONT_REQUESTS.map(([font, text]) => document.fonts.load(font, text)),
    ).then(() => undefined);
    return fontLoad;
}
