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

/**
 * A request an Inbox card started and is waiting on: merging its pull request, or sending one of its answer options.
 */
export type CommanderInboxPendingAction = 'answer' | 'merge';

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
    /**
     * Items with a request in flight, so their card shows progress and refuses a second press until it settles.
     */
    pendingActions: Readonly<Record<string, CommanderInboxPendingAction>>;
    /**
     * Items the user dismissed whose request is still waiting for Undo or in flight; the list hides them.
     */
    dismissingIds: Readonly<Record<string, true>>;
    /**
     * Set when the status bar's `N need you` chip asked for the Inbox; the list moves focus to its first open item once
     * it has rendered, then clears it.
     */
    isFocusRequested: boolean;
}

export const useCommanderInboxUiStore = createStore<CommanderInboxUiState>(
    'agent-commander-inbox',
    () => ({
        isVisible: isStoredVisible(),
        width: storedWidth(),
        focusEpoch: 0,
        pendingActions: {},
        dismissingIds: {},
        isFocusRequested: false,
    }),
);

/**
 * Runs one card request while marking the item pending, and clears the mark however the request ends. A second request
 * for an item that already has one in flight is dropped and resolves `undefined`, so a double click cannot merge or
 * answer twice.
 */
export async function runCommanderInboxAction<Result>(
    itemId: string,
    action: CommanderInboxPendingAction,
    run: () => Promise<Result>,
): Promise<Result | undefined> {
    if (Object.hasOwn(useCommanderInboxUiStore.getState().pendingActions, itemId)) return undefined;
    useCommanderInboxUiStore.setState((state) => ({
        pendingActions: { ...state.pendingActions, [itemId]: action },
    }));
    try {
        return await run();
    } finally {
        useCommanderInboxUiStore.setState((state) => {
            const pendingActions = { ...state.pendingActions };
            delete pendingActions[itemId];
            return { pendingActions };
        });
    }
}

/**
 * Hides or shows an item's card while its dismissal waits for Undo.
 */
export function setCommanderInboxDismissing(itemId: string, isDismissing: boolean): void {
    useCommanderInboxUiStore.setState((state) => {
        const dismissingIds = { ...state.dismissingIds };
        if (isDismissing) dismissingIds[itemId] = true;
        else delete dismissingIds[itemId];
        return { dismissingIds };
    });
}

export function setCommanderInboxVisible(isVisible: boolean): void {
    useCommanderInboxUiStore.setState({ isVisible });
    try {
        localStorage.setItem(VISIBILITY_STORAGE_KEY, String(isVisible));
    } catch {
        // Storage-disabled windows keep the choice for this Renderer lifetime.
    }
}

/**
 * Opens the Inbox (a drawer in a narrow window, see `CommanderInboxColumn`) and asks its list to focus the first open
 * item, remembering the column as open like the title bar toggle does.
 */
export function revealCommanderInbox(): void {
    setCommanderInboxVisible(true);
    useCommanderInboxUiStore.setState({ isFocusRequested: true });
}

/**
 * Settles a focus request once the list has rendered: there is nothing to focus in an empty Inbox either.
 */
export function settleCommanderInboxFocusRequest(): void {
    useCommanderInboxUiStore.setState({ isFocusRequested: false });
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
