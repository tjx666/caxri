import { describe, expect, it, vi } from 'vitest';

import { reconcileTerminalProcessFocus } from './terminal-process-focus';

describe('reconcileTerminalProcessFocus', () => {
    it('does not reclaim focus when a modal opens before the scheduled frame', () => {
        let scheduled: FrameRequestCallback | undefined;
        let modalOpen = false;
        const focus = vi.fn();

        reconcileTerminalProcessFocus({
            active: true,
            blur: vi.fn(),
            focus,
            isModalOpen: () => modalOpen,
            isRunning: true,
            requestFrame: (callback) => {
                scheduled = callback;
                return 1;
            },
            shouldPreserveFocus: () => false,
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
            isModalOpen: () => false,
            isRunning: true,
            requestFrame: (callback) => {
                callback(0);
                return 1;
            },
            shouldPreserveFocus: () => false,
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
            isModalOpen: () => false,
            isRunning: true,
            requestFrame,
            shouldPreserveFocus: () => false,
        });

        expect(blur).toHaveBeenCalledOnce();
        expect(requestFrame).not.toHaveBeenCalled();
    });

    it('preserves an explicitly keyboard-focused work tab during automatic activation', () => {
        const focus = vi.fn();

        reconcileTerminalProcessFocus({
            active: true,
            blur: vi.fn(),
            focus,
            isModalOpen: () => false,
            isRunning: true,
            requestFrame: (callback) => {
                callback(0);
                return 1;
            },
            shouldPreserveFocus: () => true,
        });

        expect(focus).not.toHaveBeenCalled();
    });
});
