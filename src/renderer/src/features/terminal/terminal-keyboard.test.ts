import { describe, expect, it } from 'vitest';

import {
    CODEX_IMAGE_PASTE_INPUT,
    isClipboardContainingImage,
    terminalKeyboardInput,
} from './terminal-keyboard';

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
    return {
        altKey: false,
        ctrlKey: false,
        key: '',
        metaKey: false,
        shiftKey: false,
        type: 'keydown',
        ...overrides,
    } as KeyboardEvent;
}

describe('terminalKeyboardInput', () => {
    it('maps Shift+Enter to ESC+CR newline input only for Agent Terminals', () => {
        const event = keyEvent({ key: 'Enter', shiftKey: true });
        expect(terminalKeyboardInput(event, true)).toBe('\u{1B}\r');
        expect(terminalKeyboardInput(event, false)).toBeUndefined();
    });

    it('maps macOS Command+Left and Command+Right to line boundaries', () => {
        expect(terminalKeyboardInput(keyEvent({ key: 'ArrowLeft', metaKey: true }), false)).toBe(
            '\u{1}',
        );
        expect(terminalKeyboardInput(keyEvent({ key: 'ArrowRight', metaKey: true }), true)).toBe(
            '\u{5}',
        );
    });

    it('leaves modified variants and keyup events to xterm', () => {
        expect(
            terminalKeyboardInput(
                keyEvent({ key: 'ArrowLeft', metaKey: true, shiftKey: true }),
                true,
            ),
        ).toBeUndefined();
        expect(
            terminalKeyboardInput(keyEvent({ key: 'Enter', shiftKey: true, type: 'keyup' }), true),
        ).toBeUndefined();
    });
});

describe('isClipboardContainingImage', () => {
    it('recognizes image MIME types and image files', () => {
        expect(
            isClipboardContainingImage({
                files: [],
                items: [],
                types: ['image/png'],
            }),
        ).toBe(true);
        expect(
            isClipboardContainingImage({
                files: [{ type: 'image/jpeg' }],
                items: [],
                types: ['Files'],
            }),
        ).toBe(true);
    });

    it('keeps ordinary text paste on xterm native handling', () => {
        expect(
            isClipboardContainingImage({
                files: [],
                items: [],
                types: ['text/plain'],
            }),
        ).toBe(false);
        expect(CODEX_IMAGE_PASTE_INPUT).toBe('\u{16}');
    });
});
