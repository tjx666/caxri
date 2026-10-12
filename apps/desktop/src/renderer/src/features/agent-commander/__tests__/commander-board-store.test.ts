import { afterEach, describe, expect, it, vi } from 'vitest';

import { isCommanderBoardVisible } from '../commander-board-store';

const STORAGE_KEY = 'caxri.agent-commander.board-visible';

/**
 * The suite runs under Vitest's `node` environment, so a test installs `window` and `localStorage` itself. The store
 * reads storage when its module loads, which is when the Commander window opens, so each case loads a fresh copy.
 */
function stubStorage(entries: Map<string, string>): void {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
    });
}

async function openWindow() {
    vi.resetModules();
    return import('../commander-board-store');
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isCommanderBoardVisible', () => {
    it('keeps the board open unless it was explicitly collapsed', () => {
        expect(isCommanderBoardVisible(undefined)).toBe(true);
        expect(isCommanderBoardVisible(true)).toBe(true);
        expect(isCommanderBoardVisible('false')).toBe(true);
        expect(isCommanderBoardVisible(false)).toBe(false);
    });
});

describe('useCommanderBoardUiStore', () => {
    it('opens the board on a first launch', async () => {
        stubStorage(new Map());
        const { useCommanderBoardUiStore } = await openWindow();
        expect(useCommanderBoardUiStore.getState().isVisible).toBe(true);
    });

    it('keeps a collapsed board collapsed when the window opens again', async () => {
        const entries = new Map<string, string>();
        stubStorage(entries);
        const first = await openWindow();
        first.setCommanderBoardVisible(false);
        expect(first.useCommanderBoardUiStore.getState().isVisible).toBe(false);
        expect(entries.get(STORAGE_KEY)).toBe('false');

        const reopened = await openWindow();
        expect(reopened.useCommanderBoardUiStore.getState().isVisible).toBe(false);
        reopened.setCommanderBoardVisible(true);

        const expanded = await openWindow();
        expect(expanded.useCommanderBoardUiStore.getState().isVisible).toBe(true);
    });

    it('keeps the choice for this window when storage is unavailable', async () => {
        const { setCommanderBoardVisible, useCommanderBoardUiStore } = await openWindow();
        setCommanderBoardVisible(false);
        expect(useCommanderBoardUiStore.getState().isVisible).toBe(false);
    });
});
