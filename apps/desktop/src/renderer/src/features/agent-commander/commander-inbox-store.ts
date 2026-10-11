import { clamp } from 'es-toolkit';

import { createStore } from '../../lib/store';

const VISIBILITY_STORAGE_KEY = 'caxri.agent-commander.inbox-visible';
const WIDTH_STORAGE_KEY = 'caxri.agent-commander.inbox-width';

export const COMMANDER_INBOX_MIN_WIDTH = 280;
export const COMMANDER_INBOX_MAX_WIDTH = 560;
export const COMMANDER_INBOX_DEFAULT_WIDTH = 352;

/**
 * A stored width outside the current bounds, or not a number at all, falls back into range instead of breaking the
 * layout.
 */
export function commanderInboxWidth(stored: string | null): number {
    const width = Number(stored);
    if (stored === null || !Number.isFinite(width)) return COMMANDER_INBOX_DEFAULT_WIDTH;
    return clamp(Math.round(width), COMMANDER_INBOX_MIN_WIDTH, COMMANDER_INBOX_MAX_WIDTH);
}

function storedWidth(): number {
    try {
        return commanderInboxWidth(localStorage.getItem(WIDTH_STORAGE_KEY));
    } catch {
        return COMMANDER_INBOX_DEFAULT_WIDTH;
    }
}

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
     * The column width in CSS pixels, set by dragging its left edge; remembered across launches.
     */
    width: number;
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
    () => ({ isVisible: isStoredVisible(), width: storedWidth(), focusEpoch: 0 }),
);

export function setCommanderInboxVisible(isVisible: boolean): void {
    useCommanderInboxUiStore.setState({ isVisible });
    try {
        localStorage.setItem(VISIBILITY_STORAGE_KEY, String(isVisible));
    } catch {
        // Storage-disabled windows keep the choice for this Renderer lifetime.
    }
}

export function setCommanderInboxWidth(width: number): void {
    const next = commanderInboxWidth(String(width));
    useCommanderInboxUiStore.setState({ width: next });
    try {
        localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
    } catch {
        // Storage-disabled windows keep the width for this Renderer lifetime.
    }
}

export function chooseCommanderInboxReplyTarget(targetId: string | undefined): void {
    useCommanderInboxUiStore.setState((state) => ({
        targetId,
        focusEpoch: targetId ? state.focusEpoch + 1 : state.focusEpoch,
    }));
}
