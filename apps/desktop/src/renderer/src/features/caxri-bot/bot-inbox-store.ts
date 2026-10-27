import { clamp } from 'es-toolkit';

import { createStore } from '../../lib/store';

const VISIBILITY_STORAGE_KEY = 'caxri.bot.inbox-visible';
const WIDTH_STORAGE_KEY = 'caxri.bot.inbox-width';

export const BOT_INBOX_MIN_WIDTH = 280;
export const BOT_INBOX_MAX_WIDTH = 560;
export const BOT_INBOX_DEFAULT_WIDTH = 352;

/**
 * A stored width outside the current bounds, or not a number at all, falls back into range instead of breaking the
 * layout.
 */
export function botInboxWidth(stored: string | null): number {
    const width = Number(stored);
    if (stored === null || !Number.isFinite(width)) return BOT_INBOX_DEFAULT_WIDTH;
    return clamp(Math.round(width), BOT_INBOX_MIN_WIDTH, BOT_INBOX_MAX_WIDTH);
}

function storedWidth(): number {
    try {
        return botInboxWidth(localStorage.getItem(WIDTH_STORAGE_KEY));
    } catch {
        return BOT_INBOX_DEFAULT_WIDTH;
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
export type BotInboxPendingAction = 'answer' | 'merge';

interface BotInboxUiState {
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
    pendingActions: Readonly<Record<string, BotInboxPendingAction>>;
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

export const useBotInboxUiStore = createStore<BotInboxUiState>('caxri-bot-inbox', () => ({
    isVisible: isStoredVisible(),
    width: storedWidth(),
    focusEpoch: 0,
    pendingActions: {},
    dismissingIds: {},
    isFocusRequested: false,
}));

/**
 * Runs one card request while marking the item pending, and clears the mark however the request ends. A second request
 * for an item that already has one in flight is dropped and resolves `undefined`, so a double click cannot merge or
 * answer twice.
 */
export async function runBotInboxAction<Result>(
    itemId: string,
    action: BotInboxPendingAction,
    run: () => Promise<Result>,
): Promise<Result | undefined> {
    if (Object.hasOwn(useBotInboxUiStore.getState().pendingActions, itemId)) return undefined;
    useBotInboxUiStore.setState((state) => ({
        pendingActions: { ...state.pendingActions, [itemId]: action },
    }));
    try {
        return await run();
    } finally {
        useBotInboxUiStore.setState((state) => {
            const pendingActions = { ...state.pendingActions };
            delete pendingActions[itemId];
            return { pendingActions };
        });
    }
}

/**
 * Hides or shows an item's card while its dismissal waits for Undo.
 */
export function setBotInboxDismissing(itemId: string, isDismissing: boolean): void {
    useBotInboxUiStore.setState((state) => {
        const dismissingIds = { ...state.dismissingIds };
        if (isDismissing) dismissingIds[itemId] = true;
        else delete dismissingIds[itemId];
        return { dismissingIds };
    });
}

export function setBotInboxVisible(isVisible: boolean): void {
    useBotInboxUiStore.setState({ isVisible });
    try {
        localStorage.setItem(VISIBILITY_STORAGE_KEY, String(isVisible));
    } catch {
        // Storage-disabled windows keep the choice for this Renderer lifetime.
    }
}

/**
 * Opens the Inbox (a drawer in a narrow window, see `BotInboxColumn`) and asks its list to focus the first open item,
 * remembering the column as open like the title bar toggle does.
 */
export function revealBotInbox(): void {
    setBotInboxVisible(true);
    useBotInboxUiStore.setState({ isFocusRequested: true });
}

/**
 * Settles a focus request once the list has rendered: there is nothing to focus in an empty Inbox either.
 */
export function settleBotInboxFocusRequest(): void {
    useBotInboxUiStore.setState({ isFocusRequested: false });
}

export function setBotInboxWidth(width: number): void {
    const next = botInboxWidth(String(width));
    useBotInboxUiStore.setState({ width: next });
    try {
        localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
    } catch {
        // Storage-disabled windows keep the width for this Renderer lifetime.
    }
}

export function chooseBotInboxReplyTarget(targetId: string | undefined): void {
    useBotInboxUiStore.setState((state) => ({
        targetId,
        focusEpoch: targetId ? state.focusEpoch + 1 : state.focusEpoch,
    }));
}
