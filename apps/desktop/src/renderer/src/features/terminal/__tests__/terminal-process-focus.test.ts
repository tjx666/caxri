import { describe, expect, it, vi } from 'vitest';

import {
    canClaimTerminalFocus,
    reconcileTerminalProcessFocus,
    shouldAutoFocusTerminal,
} from '../terminal-process-focus';

const focusedElement = (): HTMLElement | null => null;

function keyboardFocusedWorkTab(terminalId: string): HTMLElement {
    return {
        closest: (selector: string) =>
            selector === '.work-tab' ? { dataset: { terminalId } } : null,
        dataset: { preserveTerminalFocus: 'true' },
    } as unknown as HTMLElement;
}

function editableFocusedElement(): HTMLElement {
    return {
        closest: (selector: string) => (selector.includes('input') ? { dataset: {} } : null),
        dataset: {},
    } as unknown as HTMLElement;
}

function focusedInboxItem(): HTMLElement {
    return {
        closest: (selector: string) =>
            selector === '[data-keeps-keyboard-focus]' ? { dataset: {} } : null,
        dataset: {},
    } as unknown as HTMLElement;
}

describe('reconcileTerminalProcessFocus', () => {
    it.each([
        { active: true, isRunning: false, name: 'stopped' },
        { active: false, isRunning: true, name: 'inactive' },
    ])('does not refocus a $name Terminal from an earlier running frame', (next) => {
        let scheduled: FrameRequestCallback | undefined;
        const focus = vi.fn();
        const blur = vi.fn();
        const options = {
            active: true,
            blur,
            focus,
            getFocusedElement: focusedElement,
            isModalOpen: () => false,
            isRunning: true,
            requestFrame: (callback: FrameRequestCallback) => {
                scheduled = callback;
                return 1;
            },
            terminalId: 'terminal-1',
        };
        const cleanup = reconcileTerminalProcessFocus(options);
        cleanup?.();
        reconcileTerminalProcessFocus({ ...options, ...next });
        scheduled?.(0);

        expect(blur).toHaveBeenCalledOnce();
        expect(focus).not.toHaveBeenCalled();
    });

    it('does not reclaim focus when a modal opens before the scheduled frame', () => {
        let scheduled: FrameRequestCallback | undefined;
        let isModalOpen = false;
        const focus = vi.fn();

        reconcileTerminalProcessFocus({
            active: true,
            blur: vi.fn(),
            focus,
            getFocusedElement: focusedElement,
            isModalOpen: () => isModalOpen,
            isRunning: true,
            requestFrame: (callback) => {
                scheduled = callback;
                return 1;
            },
            terminalId: 'terminal-1',
        });

        isModalOpen = true;
        scheduled?.(0);

        expect(focus).not.toHaveBeenCalled();
    });

    it('focuses a running active Terminal when no modal owns the keyboard', () => {
        const focus = vi.fn();

        reconcileTerminalProcessFocus({
            active: true,
            blur: vi.fn(),
            focus,
            getFocusedElement: focusedElement,
            isModalOpen: () => false,
            isRunning: true,
            requestFrame: (callback) => {
                callback(0);
                return 1;
            },
            terminalId: 'terminal-1',
        });

        expect(focus).toHaveBeenCalledOnce();
    });

    it('does not reclaim focus from an editable control that wins before the scheduled frame', () => {
        let scheduled: FrameRequestCallback | undefined;
        let focusedElement: HTMLElement | null = null;
        const focus = vi.fn();

        reconcileTerminalProcessFocus({
            active: true,
            blur: vi.fn(),
            focus,
            getFocusedElement: () => focusedElement,
            isModalOpen: () => false,
            isRunning: true,
            requestFrame: (callback) => {
                scheduled = callback;
                return 1;
            },
            terminalId: 'terminal-1',
        });

        focusedElement = editableFocusedElement();
        scheduled?.(0);

        expect(focus).not.toHaveBeenCalled();
    });

    it('blurs an inactive Terminal without scheduling focus', () => {
        const blur = vi.fn();
        const requestFrame = vi.fn();

        reconcileTerminalProcessFocus({
            active: false,
            blur,
            focus: vi.fn(),
            getFocusedElement: focusedElement,
            isModalOpen: () => false,
            isRunning: true,
            requestFrame,
            terminalId: 'terminal-1',
        });

        expect(blur).toHaveBeenCalledOnce();
        expect(requestFrame).not.toHaveBeenCalled();
    });

    it('preserves an explicitly keyboard-focused work tab during process-state activation', () => {
        const tab = keyboardFocusedWorkTab('terminal-1');
        const focus = vi.fn();

        reconcileTerminalProcessFocus({
            active: true,
            blur: vi.fn(),
            focus,
            getFocusedElement: () => tab,
            isModalOpen: () => false,
            isRunning: true,
            requestFrame: (callback) => {
                callback(0);
                return 1;
            },
            terminalId: 'terminal-1',
        });

        expect(focus).not.toHaveBeenCalled();
    });

    it('preserves an explicitly keyboard-focused work tab when initial attachment settles', () => {
        const tab = keyboardFocusedWorkTab('terminal-1');

        expect(
            shouldAutoFocusTerminal({
                active: true,
                focusedElement: tab,
                isModalOpen: false,
                isRunning: true,
                terminalId: 'terminal-1',
            }),
        ).toBe(false);
    });

    it('does not preserve a keyboard marker from another Terminal', () => {
        const tab = keyboardFocusedWorkTab('terminal-2');

        expect(
            shouldAutoFocusTerminal({
                active: true,
                focusedElement: tab,
                isModalOpen: false,
                isRunning: true,
                terminalId: 'terminal-1',
            }),
        ).toBe(true);
    });
});

describe('canClaimTerminalFocus', () => {
    it('lets a Chat composer claim focus from nothing or a clicked tab', () => {
        expect(
            canClaimTerminalFocus({
                focusedElement: focusedElement(),
                isModalOpen: false,
                terminalId: 'terminal-1',
            }),
        ).toBe(true);
        expect(
            canClaimTerminalFocus({
                focusedElement: keyboardFocusedWorkTab('terminal-2'),
                isModalOpen: false,
                terminalId: 'terminal-1',
            }),
        ).toBe(true);
    });

    it('leaves focus in a region that keeps it, such as the Commander Inbox item the Needs you chip focused', () => {
        expect(
            canClaimTerminalFocus({
                focusedElement: focusedInboxItem(),
                isModalOpen: false,
                terminalId: 'terminal-1',
            }),
        ).toBe(false);
    });

    it('defers to a modal, an editable control, and roving tab navigation', () => {
        expect(
            canClaimTerminalFocus({
                focusedElement: focusedElement(),
                isModalOpen: true,
                terminalId: 'terminal-1',
            }),
        ).toBe(false);
        expect(
            canClaimTerminalFocus({
                focusedElement: editableFocusedElement(),
                isModalOpen: false,
                terminalId: 'terminal-1',
            }),
        ).toBe(false);
        expect(
            canClaimTerminalFocus({
                focusedElement: keyboardFocusedWorkTab('terminal-1'),
                isModalOpen: false,
                terminalId: 'terminal-1',
            }),
        ).toBe(false);
    });
});
