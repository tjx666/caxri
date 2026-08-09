import { describe, expect, it } from 'vitest';

import {
    CODEX_IMAGE_PASTE_INPUT,
    clipboardContainsImage,
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
    it('maps Shift+Enter to Codex multiline input only for Codex Terminals', () => {
        const event = keyEvent({ key: 'Enter', shiftKey: true });
        expect(terminalKeyboardInput(event, true)).toBe('\x1b\r');
        expect(terminalKeyboardInput(event, false)).toBeUndefined();
    });

    it('maps macOS Command+Left and Command+Right to line boundaries', () => {
        expect(terminalKeyboardInput(keyEvent({ key: 'ArrowLeft', metaKey: true }), false)).toBe(
            '\x01',
        );
        expect(terminalKeyboardInput(keyEvent({ key: 'ArrowRight', metaKey: true }), true)).toBe(
            '\x05',
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

describe('clipboardContainsImage', () => {
    it('recognizes image MIME types and image files', () => {
        expect(
            clipboardContainsImage({
                files: [],
                items: [],
                types: ['image/png'],
            }),
        ).toBe(true);
        expect(
            clipboardContainsImage({
                files: [{ type: 'image/jpeg' }],
                items: [],
                types: ['Files'],
            }),
        ).toBe(true);
    });

    it('keeps ordinary text paste on xterm native handling', () => {
        expect(
            clipboardContainsImage({
                files: [],
                items: [],
                types: ['text/plain'],
            }),
        ).toBe(false);
        expect(CODEX_IMAGE_PASTE_INPUT).toBe('\x16');
    });
});
