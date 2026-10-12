import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/selectors', () => ({ getBootstrap: vi.fn() }));

import {
    clearActiveTerminal,
    copyActiveTerminalSelection,
    didPasteIntoTerminal,
    focusTerminalById,
    getTerminalFocusElement,
    hasActiveTerminalSelection,
    isTerminalAttached,
    markTerminalAttached,
    registerTerminalClearHandler,
    registerTerminalFocusHandler,
    registerTerminalPasteHandler,
    registerTerminalSelectionHandlers,
    whenTerminalAttached,
} from '../terminal-pane-handlers';

describe('clear handler registration contract', () => {
    it('routes clearActiveTerminal to the registered handler', () => {
        const handler = vi.fn();
        registerTerminalClearHandler('terminal-1', handler);

        clearActiveTerminal('terminal-1');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('stops routing to the handler once its own unregister callback runs', () => {
        const handler = vi.fn();
        const unregister = registerTerminalClearHandler('terminal-1', handler);

        unregister();
        clearActiveTerminal('terminal-1');

        expect(handler).not.toHaveBeenCalled();
    });

    it('does not let a stale unregister callback evict a newer handler for the same id', () => {
        const firstHandler = vi.fn();
        const secondHandler = vi.fn();
        const unregisterFirst = registerTerminalClearHandler('terminal-1', firstHandler);
        registerTerminalClearHandler('terminal-1', secondHandler);

        // A pane that already lost ownership (e.g. after remount) must not evict its successor.
        unregisterFirst();
        clearActiveTerminal('terminal-1');

        expect(firstHandler).not.toHaveBeenCalled();
        expect(secondHandler).toHaveBeenCalledTimes(1);
    });
});

describe('paste handler registration contract', () => {
    it('routes data to the mounted Terminal and returns whether it accepted the paste', () => {
        const handlers = { paste: vi.fn(() => true) };
        const unregister = registerTerminalPasteHandler('terminal-paste-1', handlers);

        expect(didPasteIntoTerminal('terminal-paste-1', "'/repo/a file.txt'")).toBe(true);
        expect(handlers.paste).toHaveBeenCalledWith("'/repo/a file.txt'");

        unregister();
    });

    it('returns false after unregister and does not let stale cleanup evict a newer pane', () => {
        const firstHandlers = { paste: vi.fn(() => true) };
        const secondHandlers = { paste: vi.fn(() => true) };
        const unregisterFirst = registerTerminalPasteHandler('terminal-paste-2', firstHandlers);
        const unregisterSecond = registerTerminalPasteHandler('terminal-paste-2', secondHandlers);

        unregisterFirst();

        expect(didPasteIntoTerminal('terminal-paste-2', '/repo/folder')).toBe(true);
        expect(firstHandlers.paste).not.toHaveBeenCalled();
        expect(secondHandlers.paste).toHaveBeenCalledWith('/repo/folder');

        unregisterSecond();
        expect(didPasteIntoTerminal('terminal-paste-2', '/repo/folder')).toBe(false);
    });
});

describe('focus handler registration contract', () => {
    it('routes focus to the mounted Terminal handler', () => {
        const handler = vi.fn();
        const unregister = registerTerminalFocusHandler('terminal-focus', handler);

        focusTerminalById('terminal-focus');

        expect(handler).toHaveBeenCalledTimes(1);
        unregister();
    });

    it('exposes the mounted Terminal focus element and yields null for unknown or element-less handlers', () => {
        const element = {} as HTMLElement;
        const unregister = registerTerminalFocusHandler('terminal-focus', vi.fn(), () => element);
        const unregisterBare = registerTerminalFocusHandler('terminal-bare', vi.fn());

        expect(getTerminalFocusElement('terminal-focus')).toBe(element);
        expect(getTerminalFocusElement('terminal-bare')).toBeNull();
        expect(getTerminalFocusElement('terminal-missing')).toBeNull();
        unregister();
        unregisterBare();
        expect(getTerminalFocusElement('terminal-focus')).toBeNull();
    });

    it('does not let a stale unregister callback evict a newer focus handler', () => {
        const firstHandler = vi.fn();
        const secondHandler = vi.fn();
        const unregisterFirst = registerTerminalFocusHandler('terminal-focus', firstHandler);
        const unregisterSecond = registerTerminalFocusHandler('terminal-focus', secondHandler);

        unregisterFirst();
        focusTerminalById('terminal-focus');

        expect(firstHandler).not.toHaveBeenCalled();
        expect(secondHandler).toHaveBeenCalledTimes(1);
        unregisterSecond();
    });
});

describe('selection handler registration contract', () => {
    it('routes copySelection and hasSelection to the registered handlers', () => {
        const handlers = { copySelection: vi.fn(), hasSelection: vi.fn(() => true) };
        registerTerminalSelectionHandlers('terminal-1', handlers);

        copyActiveTerminalSelection('terminal-1');

        expect(handlers.copySelection).toHaveBeenCalledTimes(1);
        expect(hasActiveTerminalSelection('terminal-1')).toBe(true);
    });

    it('reports no selection once its own unregister callback runs', () => {
        const handlers = { copySelection: vi.fn(), hasSelection: vi.fn(() => true) };
        const unregister = registerTerminalSelectionHandlers('terminal-1', handlers);

        unregister();

        expect(hasActiveTerminalSelection('terminal-1')).toBe(false);
        copyActiveTerminalSelection('terminal-1');
        expect(handlers.copySelection).not.toHaveBeenCalled();
    });

    it('does not let a stale unregister callback evict a newer handler set for the same id', () => {
        const firstHandlers = { copySelection: vi.fn(), hasSelection: vi.fn(() => false) };
        const secondHandlers = { copySelection: vi.fn(), hasSelection: vi.fn(() => true) };
        const unregisterFirst = registerTerminalSelectionHandlers('terminal-1', firstHandlers);
        registerTerminalSelectionHandlers('terminal-1', secondHandlers);

        unregisterFirst();

        expect(hasActiveTerminalSelection('terminal-1')).toBe(true);
        copyActiveTerminalSelection('terminal-1');
        expect(secondHandlers.copySelection).toHaveBeenCalledTimes(1);
        expect(firstHandlers.copySelection).not.toHaveBeenCalled();
    });
});

describe('terminal attachment registry', () => {
    it('resolves immediately for an already attached Terminal', async () => {
        markTerminalAttached('attached-1', true);
        await expect(whenTerminalAttached('attached-1', 10)).resolves.toBe(true);
        expect(isTerminalAttached('attached-1')).toBe(true);
    });

    it('resolves pending waiters once the pane reports its attach, and no longer after unmount', async () => {
        const pending = whenTerminalAttached('attached-2', 1000);
        markTerminalAttached('attached-2', true);
        await expect(pending).resolves.toBe(true);
        markTerminalAttached('attached-2', false);
        expect(isTerminalAttached('attached-2')).toBe(false);
    });

    it('gives up after the timeout when no pane attaches', async () => {
        vi.useFakeTimers();
        try {
            const pending = whenTerminalAttached('attached-3', 50);
            await vi.advanceTimersByTimeAsync(50);
            await expect(pending).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
