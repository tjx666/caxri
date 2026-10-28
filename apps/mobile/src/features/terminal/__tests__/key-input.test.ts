import { describe, expect, it } from 'vitest';

import { controlByteFor, encodeTerminalKey, pressTerminalKey } from '../key-input';

describe('mobile Terminal key input', () => {
    it('encodes menu navigation and submission as exact terminal bytes', () => {
        expect(encodeTerminalKey('escape', false)).toBe('\u{1B}');
        expect(encodeTerminalKey('tab', false)).toBe('\t');
        expect(encodeTerminalKey('shift-tab', false)).toBe('\u{1B}[Z');
        expect(encodeTerminalKey('shift-tab', true)).toBeNull();
        expect(encodeTerminalKey('up', false)).toBe('\u{1B}[A');
        expect(encodeTerminalKey('down', false)).toBe('\u{1B}[B');
        expect(encodeTerminalKey('right', false)).toBe('\u{1B}[C');
        expect(encodeTerminalKey('left', false)).toBe('\u{1B}[D');
        expect(encodeTerminalKey('enter', false)).toBe('\r');
        expect(encodeTerminalKey('1', false)).toBe('1');
    });

    it('encodes Ctrl arrow modifiers and supported printable combinations', () => {
        expect(encodeTerminalKey('down', true)).toBe('\u{1B}[1;5B');
        expect(encodeTerminalKey('c', true)).toBe('\u{3}');
        expect(encodeTerminalKey('2', true)).toBe('\u{0}');
        expect(encodeTerminalKey('1', true)).toBeNull();
    });

    it('uses Ctrl only for the next key, including unsupported combinations', () => {
        const armed = pressTerminalKey(false, 'ctrl');
        expect(armed).toEqual({ ctrl: true, bytes: null });
        expect(pressTerminalKey(armed.ctrl, 'down')).toEqual({ ctrl: false, bytes: '\u{1B}[1;5B' });
        expect(pressTerminalKey(armed.ctrl, '1')).toEqual({ ctrl: false, bytes: null });
        expect(pressTerminalKey(true, 'ctrl')).toEqual({ ctrl: false, bytes: null });
    });

    it('turns one typed character into its Ctrl byte while Ctrl is armed', () => {
        expect(controlByteFor('c')).toBe('\u{3}');
        expect(controlByteFor('C')).toBe('\u{3}');
        expect(controlByteFor('[')).toBe('\u{1B}');
        expect(controlByteFor(' ')).toBe('\u{0}');
        expect(controlByteFor('1')).toBeNull();
        expect(controlByteFor('ab')).toBeNull();
    });
});
