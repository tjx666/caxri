export const TERMINAL_FONT_FAMILY =
    '"Caxri JetBrains Mono", "Caxri Nerd Symbols", SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const BUNDLED_FONT_REQUESTS = [
    ['400 13px "Caxri JetBrains Mono"', 'Caxri'],
    ['700 13px "Caxri JetBrains Mono"', 'Caxri'],
    ['italic 400 13px "Caxri JetBrains Mono"', 'Caxri'],
    ['italic 700 13px "Caxri JetBrains Mono"', 'Caxri'],
    ['400 13px "Caxri Nerd Symbols"', '\u{E0B0}\u{F17C}'],
] as const;

const fontLoadState: { current: Promise<void> | undefined } = { current: undefined };

/**
 * Loads bundled faces before xterm measures cells, following Kero's font cascade.
 * https://github.com/egoist/kero/blob/main/kero/TerminalFont.swift
 */
export async function loadTerminalFonts(): Promise<void> {
    fontLoadState.current ??= (async (): Promise<void> => {
        await Promise.all(
            BUNDLED_FONT_REQUESTS.map(([font, text]) => document.fonts.load(font, text)),
        );
    })();
    await fontLoadState.current;
}
