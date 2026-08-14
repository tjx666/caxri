import { describe, expect, it, vi } from 'vitest';

import { reconcileTerminalProcessFocus, shouldAutoFocusTerminal } from './terminal-process-focus';

const focusedElement = (): HTMLElement | null => null;

function keyboardFocusedWorkTab(terminalId: string): HTMLElement {
    return {
        closest: () => ({ getAttribute: () => terminalId }),
        dataset: { preserveTerminalFocus: 'true' },
    } as unknown as HTMLElement;
}

describe('reconcileTerminalProcessFocus', () => {
    it('does not reclaim focus when a modal opens before the scheduled frame', () => {
        let scheduled: FrameRequestCallback | undefined;
        let modalOpen = false;
        const focus = vi.fn();

        reconcileTerminalProcessFocus({
            active: true,
            blur: vi.fn(),
            focus,
            getFocusedElement: focusedElement,
            isModalOpen: () => modalOpen,
            isRunning: true,
            requestFrame: (callback) => {
                scheduled = callback;
                return 1;
            },
            terminalId: 'terminal-1',
        });

        modalOpen = true;
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
