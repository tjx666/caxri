import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

const VISIBILITY_STORAGE_KEY = 'caxri.agent-commander.board-visible';

/**
 * The board starts open. Only an explicit stored `false` keeps it collapsed, so a missing or corrupt entry never hides
 * the Sessions the window exists to show.
 */
export function isCommanderBoardVisible(stored: unknown): boolean {
    return stored !== false;
}

interface CommanderBoardUiState {
    /**
     * Whether the Sessions board column on the left is open; remembered across launches of this window, open by
     * default. The column has a fixed width, so collapsing it is the only layout choice to remember.
     */
    isVisible: boolean;
}

export const useCommanderBoardUiStore = createStore<CommanderBoardUiState>(
    'agent-commander-board',
    () => ({ isVisible: isCommanderBoardVisible(readLocalStorageJson(VISIBILITY_STORAGE_KEY)) }),
);

export function setCommanderBoardVisible(isVisible: boolean): void {
    useCommanderBoardUiStore.setState({ isVisible });
    writeLocalStorageJson(VISIBILITY_STORAGE_KEY, isVisible);
}
