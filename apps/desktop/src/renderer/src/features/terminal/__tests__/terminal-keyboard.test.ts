import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    isClipboardContainingImage,
    registerTerminalClipboardHandlers,
    terminalCommandKeyOwner,
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
    it('maps Shift+Enter to ESC+CR newline input only while an Agent child is running', () => {
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

describe('terminalCommandKeyOwner', () => {
    it('forwards Cmd+C to the app only without a Terminal selection', () => {
        const event = keyEvent({ key: 'c', metaKey: true });
        expect(terminalCommandKeyOwner(event, false)).toBe('xterm');
        expect(terminalCommandKeyOwner(event, true)).toBe('caxri');
        expect(terminalCommandKeyOwner({ ...event, type: 'keyup' }, false)).toBe('xterm');
        expect(
            terminalCommandKeyOwner(keyEvent({ key: 'C', metaKey: true, shiftKey: true }), false),
        ).toBe('caxri');
    });

    it('keeps other Command character chords and a lone Command press with Caxri', () => {
        expect(terminalCommandKeyOwner(keyEvent({ key: 'v', metaKey: true }), false)).toBe('caxri');
        expect(terminalCommandKeyOwner(keyEvent({ key: 't', metaKey: true }), false)).toBe('caxri');
        expect(terminalCommandKeyOwner(keyEvent({ key: 'Meta', metaKey: true }), false)).toBe(
            'caxri',
        );
    });

    it('selects the Terminal buffer on Cmd+A keydown', () => {
        expect(terminalCommandKeyOwner(keyEvent({ key: 'a', metaKey: true }), false)).toBe(
            'select-all',
        );
        expect(
            terminalCommandKeyOwner(keyEvent({ key: 'a', metaKey: true, type: 'keyup' }), false),
        ).toBe('caxri');
    });

    it('leaves non-Command keys and Command chords on non-character keys to xterm', () => {
        expect(terminalCommandKeyOwner(keyEvent({ key: 'c', ctrlKey: true }), false)).toBe('xterm');
        expect(terminalCommandKeyOwner(keyEvent({ key: 'Enter', metaKey: true }), false)).toBe(
            'xterm',
        );
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
            terminalImagePasteInput(textClipboard, catalogImagePasteInput('codex'), true),
        ).toBeUndefined();
    });

    it('intercepts image paste only for a running Agent with a catalogued capability', () => {
        const imageClipboard = { files: [], items: [], types: ['image/png'] };
        expect(terminalImagePasteInput(imageClipboard, catalogImagePasteInput('codex'), true)).toBe(
            '\u{16}',
        );
        expect(
            terminalImagePasteInput(imageClipboard, catalogImagePasteInput('claude'), true),
        ).toBeUndefined();
        expect(
            terminalImagePasteInput(imageClipboard, catalogImagePasteInput('codex'), false),
        ).toBeUndefined();
    });
});

describe('registerTerminalClipboardHandlers', () => {
    it('stops an empty Terminal copy from reaching Chromium', () => {
        const helper = {} as Element;
        const container = Object.assign(new EventTarget(), {
            contains: (node: Node | null) => node === helper,
        }) as HTMLElement;
        const testDocument = Object.assign(new EventTarget(), {
            activeElement: helper,
        }) as Document;
        const unregister = registerTerminalClipboardHandlers({
            canAcceptAgentInput: () => true,
            container,
            document: testDocument,
            getSelection: () => '',
            imagePasteInput: () => {},
            pasteImage: vi.fn(),
            pasteText: vi.fn(() => false),
        });
        const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
        const setData = vi.fn();
        Object.defineProperty(event, 'clipboardData', {
            value: { setData },
        });

        testDocument.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(setData).not.toHaveBeenCalled();
        unregister();
    });

    it('claims long text paste before xterm can receive the original', () => {
        const container = new EventTarget() as HTMLElement;
        const testDocument = new EventTarget() as Document;
        const pasteText = vi.fn(() => true);
        const unregister = registerTerminalClipboardHandlers({
            canAcceptAgentInput: () => true,
            container,
            document: testDocument,
            getSelection: () => '',
            imagePasteInput: () => {},
            pasteImage: vi.fn(),
            pasteText,
        });
        const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
        Object.defineProperty(event, 'clipboardData', {
            value: { files: [], getData: () => 'long text', items: [], types: ['text/plain'] },
        });

        container.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(pasteText).toHaveBeenCalledWith('long text');
        unregister();
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

    it('blocks an empty native copy so it cannot wipe the clipboard', () => {
        const setData = vi.fn();
        const preventDefault = vi.fn();

        writeTerminalSelectionToCopyEvent({ clipboardData: { setData }, preventDefault }, '');
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(setData).not.toHaveBeenCalled();
    });

    it('leaves a non-empty copy unchanged without writable clipboard data', () => {
        const preventDefault = vi.fn();

        writeTerminalSelectionToCopyEvent({ clipboardData: null, preventDefault }, 'text');
        expect(preventDefault).not.toHaveBeenCalled();
    });
});
