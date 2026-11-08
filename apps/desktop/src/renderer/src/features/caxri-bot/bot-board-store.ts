import { clamp } from 'es-toolkit';

import { createSharedLocalState } from '../../lib/local-storage';
import { createStore } from '../../lib/store';
import type { BotBoardScope } from './bot-board';

const VISIBILITY_STORAGE_KEY = 'caxri.bot.board-visible';
const WIDTH_STORAGE_KEY = 'caxri.bot.board-width';
const SCOPE_STORAGE_KEY = 'caxri.bot.board-scope';

export const BOT_BOARD_MIN_WIDTH = 280;
export const BOT_BOARD_MAX_WIDTH = 560;
export const BOT_BOARD_DEFAULT_WIDTH = 360;

/**
 * A stored width outside the current bounds, or not a number at all, falls back into range instead of breaking the
 * layout, as the Inbox column's width does.
 */
export function botBoardWidth(stored: unknown): number {
    if (typeof stored !== 'number' || !Number.isFinite(stored)) return BOT_BOARD_DEFAULT_WIDTH;
    return clamp(Math.round(stored), BOT_BOARD_MIN_WIDTH, BOT_BOARD_MAX_WIDTH);
}

/**
 * The board starts open. Only an explicit stored `false` keeps it collapsed, so a missing or corrupt entry never hides
 * the Sessions the window exists to show.
 */
export function isBotBoardVisible(stored: unknown): boolean {
    return stored !== false;
}

/**
 * The board shows Caxri Bot's own Sessions unless the user chose every Session; anything else stored falls back to that
 * default.
 */
export function botBoardScope(stored: unknown): BotBoardScope {
    return stored === 'all' ? 'all' : 'bot';
}

interface BotBoardUiState {
    /**
     * Whether the Sessions board column on the left is open; remembered across launches, open by default.
     */
    isVisible: boolean;
    /**
     * Whether the board lists Caxri Bot's own Sessions or every Workbench Session; remembered across launches. Kept
     * here rather than in the board view so the Command Palette can switch it too.
     */
    scope: BotBoardScope;
    /**
     * The column width in CSS pixels, set by dragging its right edge; remembered across launches.
     */
    width: number;
}

/**
 * Each field has its own key, so a write never carries another field's stale value. Shared by every window of the
 * profile (docs/client-local-data.md): a width dragged in one window is the user's width in the others.
 */
const sharedVisibility = createSharedLocalState(VISIBILITY_STORAGE_KEY, isBotBoardVisible);
const sharedWidth = createSharedLocalState(WIDTH_STORAGE_KEY, botBoardWidth);
const sharedScope = createSharedLocalState(SCOPE_STORAGE_KEY, botBoardScope);

export const useBotBoardUiStore = createStore<BotBoardUiState>('caxri-bot-board', (set) => {
    // Live as long as the store. They update memory only, so another window's change never writes back.
    sharedVisibility.subscribe((isVisible) => set({ isVisible }));
    sharedWidth.subscribe((width) => set({ width }));
    sharedScope.subscribe((scope) => set({ scope }));
    return {
        isVisible: sharedVisibility.read(),
        scope: sharedScope.read(),
        width: sharedWidth.read(),
    };
});

export function setBotBoardVisible(isVisible: boolean): void {
    useBotBoardUiStore.setState({ isVisible });
    sharedVisibility.write(isVisible);
}

export function setBotBoardWidth(width: number): void {
    const next = botBoardWidth(width);
    useBotBoardUiStore.setState({ width: next });
    sharedWidth.write(next);
}

export function setBotBoardScope(scope: BotBoardScope): void {
    useBotBoardUiStore.setState({ scope });
    sharedScope.write(scope);
}
