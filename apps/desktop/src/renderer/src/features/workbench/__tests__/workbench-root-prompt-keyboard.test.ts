import { describe, expect, it } from 'vitest';

import { resolveWorkbenchRootPromptKey } from '../workbench-root-prompt-keyboard';

const chord = {
    altKey: false,
    ctrlKey: false,
    isEditableTarget: false,
    isModalOpen: false,
    key: 'Escape',
    metaKey: false,
    shiftKey: false,
};

describe('resolveWorkbenchRootPromptKey', () => {
    it('reaches the prompt from a focused Terminal', () => {
        expect(
            resolveWorkbenchRootPromptKey({ ...chord, isEditableTarget: true, shiftKey: true }),
        ).toBe('focus');
    });

    it('reaches the prompt from ordinary chrome too', () => {
        expect(resolveWorkbenchRootPromptKey({ ...chord, shiftKey: true })).toBe('focus');
    });

    it('dismisses on Escape when no editable target owns the keystroke', () => {
        expect(resolveWorkbenchRootPromptKey(chord)).toBe('dismiss');
    });

    it('leaves Escape to an open dialog instead of dismissing itself behind it', () => {
        expect(resolveWorkbenchRootPromptKey({ ...chord, isModalOpen: true })).toBe('ignore');
    });

    it('does not pull focus out of an open dialog either', () => {
        expect(resolveWorkbenchRootPromptKey({ ...chord, isModalOpen: true, shiftKey: true })).toBe(
            'ignore',
        );
    });

    it('leaves Escape to the Terminal, shell, or editor that owns it', () => {
        expect(resolveWorkbenchRootPromptKey({ ...chord, isEditableTarget: true })).toBe('ignore');
    });

    it('ignores Escape carrying another modifier', () => {
        expect(resolveWorkbenchRootPromptKey({ ...chord, metaKey: true })).toBe('ignore');
        expect(resolveWorkbenchRootPromptKey({ ...chord, ctrlKey: true })).toBe('ignore');
        expect(resolveWorkbenchRootPromptKey({ ...chord, altKey: true })).toBe('ignore');
        expect(resolveWorkbenchRootPromptKey({ ...chord, ctrlKey: true, shiftKey: true })).toBe(
            'ignore',
        );
    });

    it('ignores every other key', () => {
        expect(resolveWorkbenchRootPromptKey({ ...chord, key: 'Enter' })).toBe('ignore');
        expect(resolveWorkbenchRootPromptKey({ ...chord, key: 'Tab', shiftKey: true })).toBe(
            'ignore',
        );
    });
});
