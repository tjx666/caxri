import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    BOT_BOARD_DEFAULT_WIDTH,
    BOT_BOARD_MAX_WIDTH,
    BOT_BOARD_MIN_WIDTH,
    botBoardScope,
    botBoardWidth,
    isBotBoardVisible,
} from '../bot-board-store';

const STORAGE_KEY = 'caxri.bot.board-visible';

/**
 * The suite runs under Vitest's `node` environment, so a test installs `window` and `localStorage` itself. The store
 * reads storage when its module loads, which is when the Caxri Bot window opens, so each case loads a fresh copy.
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
    return import('../bot-board-store');
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isBotBoardVisible', () => {
    it('keeps the board open unless it was explicitly collapsed', () => {
        expect(isBotBoardVisible(undefined)).toBe(true);
        expect(isBotBoardVisible(true)).toBe(true);
        expect(isBotBoardVisible('false')).toBe(true);
        expect(isBotBoardVisible(false)).toBe(false);
    });
});

describe('useBotBoardUiStore', () => {
    it('opens the board on a first launch', async () => {
        stubStorage(new Map());
        const { useBotBoardUiStore } = await openWindow();
        expect(useBotBoardUiStore.getState().isVisible).toBe(true);
    });

    it('keeps a collapsed board collapsed when the window opens again', async () => {
        const entries = new Map<string, string>();
        stubStorage(entries);
        const first = await openWindow();
        first.setBotBoardVisible(false);
        expect(first.useBotBoardUiStore.getState().isVisible).toBe(false);
        expect(entries.get(STORAGE_KEY)).toBe('false');

        const reopened = await openWindow();
        expect(reopened.useBotBoardUiStore.getState().isVisible).toBe(false);
        reopened.setBotBoardVisible(true);

        const expanded = await openWindow();
        expect(expanded.useBotBoardUiStore.getState().isVisible).toBe(true);
    });

    it('keeps the choice for this window when storage is unavailable', async () => {
        const { setBotBoardVisible, useBotBoardUiStore } = await openWindow();
        setBotBoardVisible(false);
        expect(useBotBoardUiStore.getState().isVisible).toBe(false);
    });
});

describe('botBoardScope', () => {
    it("shows Caxri Bot's own Sessions unless every Session was chosen", () => {
        expect(botBoardScope('all')).toBe('all');
        expect(botBoardScope('bot')).toBe('bot');
        expect(botBoardScope(undefined)).toBe('bot');
        expect(botBoardScope(42)).toBe('bot');
    });

    it('remembers the scope the next time the window opens', async () => {
        const entries = new Map<string, string>();
        stubStorage(entries);
        const first = await openWindow();
        expect(first.useBotBoardUiStore.getState().scope).toBe('bot');
        first.setBotBoardScope('all');

        const reopened = await openWindow();
        expect(reopened.useBotBoardUiStore.getState().scope).toBe('all');
    });
});

describe('botBoardWidth', () => {
    it('keeps a stored width inside the column bounds', () => {
        expect(botBoardWidth(undefined)).toBe(BOT_BOARD_DEFAULT_WIDTH);
        expect(botBoardWidth('400')).toBe(BOT_BOARD_DEFAULT_WIDTH);
        expect(botBoardWidth(NaN)).toBe(BOT_BOARD_DEFAULT_WIDTH);
        expect(botBoardWidth(412.4)).toBe(412);
        expect(botBoardWidth(10)).toBe(BOT_BOARD_MIN_WIDTH);
        expect(botBoardWidth(9_999)).toBe(BOT_BOARD_MAX_WIDTH);
    });

    it('remembers a dragged width when the window opens again', async () => {
        const entries = new Map<string, string>();
        stubStorage(entries);
        const first = await openWindow();
        first.setBotBoardWidth(420);
        expect(entries.get('caxri.bot.board-width')).toBe('420');
        const reopened = await openWindow();
        expect(reopened.useBotBoardUiStore.getState().width).toBe(420);
    });
});
