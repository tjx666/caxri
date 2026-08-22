import type { AgentProvider } from '@shared/agents';
import { agentProviderCatalog } from '@shared/agents';
import { describe, expect, it, vi } from 'vitest';

import {
    isClipboardContainingImage,
    terminalImagePasteInput,
    terminalKeyboardInput,
    writeTerminalSelectionToCopyEvent,
} from '../terminal-keyboard';

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

function catalogImagePasteInput(provider: AgentProvider): string | undefined {
    return agentProviderCatalog[provider].imageInput?.terminalInput;
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
        const textClipboard = { files: [], items: [], types: ['text/plain'] };
        expect(isClipboardContainingImage(textClipboard)).toBe(false);
        expect(
            terminalImagePasteInput(textClipboard, catalogImagePasteInput('codex')),
        ).toBeUndefined();
    });

    it('intercepts image paste only when the provider catalog declares an input capability', () => {
        const imageClipboard = { files: [], items: [], types: ['image/png'] };
        expect(terminalImagePasteInput(imageClipboard, catalogImagePasteInput('codex'))).toBe(
            '\u{16}',
        );
        expect(
            terminalImagePasteInput(imageClipboard, catalogImagePasteInput('claude')),
        ).toBeUndefined();
    });
});

describe('writeTerminalSelectionToCopyEvent', () => {
    it('writes the live xterm selection into a native copy event', () => {
        const setData = vi.fn();
        const preventDefault = vi.fn();

        writeTerminalSelectionToCopyEvent(
            { clipboardData: { setData }, preventDefault },
            'PANE_TWO',
        );
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(setData).toHaveBeenCalledWith('text/plain', 'PANE_TWO');
    });

    it('leaves copy unchanged without a selection or writable clipboard data', () => {
        const preventDefault = vi.fn();

        writeTerminalSelectionToCopyEvent(
            { clipboardData: { setData: vi.fn() }, preventDefault },
            '',
        );
        writeTerminalSelectionToCopyEvent({ clipboardData: null, preventDefault }, 'text');
        expect(preventDefault).not.toHaveBeenCalled();
    });
});
