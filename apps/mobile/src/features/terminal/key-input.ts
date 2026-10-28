export type TerminalKey =
    | 'escape'
    | 'tab'
    | 'shift-tab'
    | 'ctrl'
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | '1'
    | '2'
    | '3'
    | 'enter';

const arrows = {
    up: 'A',
    down: 'B',
    right: 'C',
    left: 'D',
} as const;

/**
 * Encodes the accessory row independently of WebView keyboard handling. Unsupported Ctrl combinations return no bytes;
 * sending their unmodified key would silently defeat the visible modifier state.
 */
export const encodeTerminalKey = (
    key: Exclude<TerminalKey, 'ctrl'> | 'c',
    isCtrl: boolean,
): string | null => {
    switch (key) {
        case 'up':
        case 'down':
        case 'left':
        case 'right': {
            const final = arrows[key];
            return isCtrl ? `\u{1B}[1;5${final}` : `\u{1B}[${final}`;
        }
        case 'escape':
            return isCtrl ? null : '\u{1B}';
        case 'tab':
            return isCtrl ? null : '\t';
        case 'shift-tab':
            // CSI Z (back-tab), which Claude Code reads as Shift+Tab to cycle its permission mode.
            return isCtrl ? null : '\u{1B}[Z';
        case 'enter':
            return isCtrl ? null : '\r';
        case '1':
            return isCtrl ? null : '1';
        case '2':
            return isCtrl ? '\u{0}' : '2';
        case '3':
            return isCtrl ? '\u{1B}' : '3';
        case 'c':
            return isCtrl ? '\u{3}' : 'c';
    }
};

export const pressTerminalKey = (
    isCtrl: boolean,
    key: TerminalKey,
): { ctrl: boolean; bytes: string | null } =>
    key === 'ctrl'
        ? { ctrl: !isCtrl, bytes: null }
        : { ctrl: false, bytes: encodeTerminalKey(key, isCtrl) };

/**
 * Maps a typed character to its Ctrl chord (`c` → ETX). Only the ASCII range that has a C0 control code qualifies;
 * anything else returns null so the armed modifier is never silently dropped.
 */
export const controlByteFor = (text: string): string | null => {
    if (text.length !== 1) return null;
    const code = text.toUpperCase().codePointAt(0) ?? 0;
    if (code >= 0x40 && code <= 0x5f) return String.fromCodePoint(code & 0x1f);
    if (text === ' ') return '\u{0}';
    return null;
};
