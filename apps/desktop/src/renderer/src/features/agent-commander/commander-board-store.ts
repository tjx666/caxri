import { clamp } from 'es-toolkit';

import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import { createStore } from '../../lib/store';
import type { CommanderBoardScope } from './commander-board';

const VISIBILITY_STORAGE_KEY = 'caxri.agent-commander.board-visible';
const WIDTH_STORAGE_KEY = 'caxri.agent-commander.board-width';
const SCOPE_STORAGE_KEY = 'caxri.agent-commander.board-scope';

export const COMMANDER_BOARD_MIN_WIDTH = 280;
export const COMMANDER_BOARD_MAX_WIDTH = 560;
export const COMMANDER_BOARD_DEFAULT_WIDTH = 360;

/**
 * A stored width outside the current bounds, or not a number at all, falls back into range instead of breaking the
 * layout, as the Inbox column's width does.
 */
export function commanderBoardWidth(stored: unknown): number {
    if (typeof stored !== 'number' || !Number.isFinite(stored))
        return COMMANDER_BOARD_DEFAULT_WIDTH;
    return clamp(Math.round(stored), COMMANDER_BOARD_MIN_WIDTH, COMMANDER_BOARD_MAX_WIDTH);
}

/**
 * The board starts open. Only an explicit stored `false` keeps it collapsed, so a missing or corrupt entry never hides
 * the Sessions the window exists to show.
 */
export function isCommanderBoardVisible(stored: unknown): boolean {
    return stored !== false;
}

/**
 * The board shows the Commander's own Sessions unless the user chose every Session; anything else stored falls back to
 * that default.
 */
export function commanderBoardScope(stored: unknown): CommanderBoardScope {
    return stored === 'all' ? 'all' : 'commander';
}

interface CommanderBoardUiState {
    /**
     * Whether the Sessions board column on the left is open; remembered across launches of this window, open by
     * default.
     */
    isVisible: boolean;
    /**
     * Whether the board lists the Commander's own Sessions or every Workbench Session; remembered across launches. Kept
     * here rather than in the board view so the Command Palette can switch it too.
     */
    scope: CommanderBoardScope;
    /**
     * The column width in CSS pixels, set by dragging its right edge; remembered across launches.
     */
    width: number;
}

export const useCommanderBoardUiStore = createStore<CommanderBoardUiState>(
    'agent-commander-board',
    () => ({
        isVisible: isCommanderBoardVisible(readLocalStorageJson(VISIBILITY_STORAGE_KEY)),
        scope: commanderBoardScope(readLocalStorageJson(SCOPE_STORAGE_KEY)),
        width: commanderBoardWidth(readLocalStorageJson(WIDTH_STORAGE_KEY)),
    }),
);

export function setCommanderBoardVisible(isVisible: boolean): void {
    useCommanderBoardUiStore.setState({ isVisible });
    writeLocalStorageJson(VISIBILITY_STORAGE_KEY, isVisible);
}

export function setCommanderBoardWidth(width: number): void {
    const next = commanderBoardWidth(width);
    useCommanderBoardUiStore.setState({ width: next });
    writeLocalStorageJson(WIDTH_STORAGE_KEY, next);
}

export function setCommanderBoardScope(scope: CommanderBoardScope): void {
    useCommanderBoardUiStore.setState({ scope });
    writeLocalStorageJson(SCOPE_STORAGE_KEY, scope);
}
