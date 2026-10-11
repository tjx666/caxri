import { createStore } from '../../lib/store';

const VISIBILITY_STORAGE_KEY = 'caxri.agent-commander.inbox-visible';

function isStoredVisible(): boolean {
    try {
        return localStorage.getItem(VISIBILITY_STORAGE_KEY) !== 'false';
    } catch {
        return true;
    }
}

interface CommanderInboxUiState {
    /**
     * Whether the Inbox column is open; remembered across launches of this window, open by default.
     */
    isVisible: boolean;
    /**
     * The item the composer replies to, chosen with `@` or a card's Reply button.
     */
    targetId?: string;
    /**
     * Bumped to move focus into the composer after a card's Reply button chose its target.
     */
    focusEpoch: number;
}

export const useCommanderInboxUiStore = createStore<CommanderInboxUiState>(
    'agent-commander-inbox',
    () => ({ isVisible: isStoredVisible(), focusEpoch: 0 }),
);

export function setCommanderInboxVisible(isVisible: boolean): void {
    useCommanderInboxUiStore.setState({ isVisible });
    try {
        localStorage.setItem(VISIBILITY_STORAGE_KEY, String(isVisible));
    } catch {
        // Storage-disabled windows keep the choice for this Renderer lifetime.
    }
}

export function chooseCommanderInboxReplyTarget(targetId: string | undefined): void {
    useCommanderInboxUiStore.setState((state) => ({
        targetId,
        focusEpoch: targetId ? state.focusEpoch + 1 : state.focusEpoch,
    }));
}
