import type { AppSettings, BotInboxItem, ServerEvent } from '@caxri/protocol';

import { translateMain } from '../locale';
import type { AgentSystemNotification, AgentSystemNotificationHandle } from './agent-notifications';

/**
 * Why a newly opened Inbox item did or did not raise a system notification. A closed set so the log can count
 * suppressed items by cause rather than only the ones that were shown.
 */
type BotInboxNotificationOutcome = 'botFocused' | 'disabled' | 'shown';

interface BotInboxNotificationDecision {
    itemCount: number;
    outcome: BotInboxNotificationOutcome;
}

interface BotInboxNotificationOptions {
    /**
     * True while Caxri Bot's window is focused: the owner is already looking at the Inbox, so a banner would only
     * repeat what the column shows.
     */
    isBotFocused(): boolean;
    loadInbox(): Promise<readonly BotInboxItem[]>;
    loadSettings(): Promise<Pick<AppSettings, 'agents.notifications.enabled'>>;
    onDecision?(decision: BotInboxNotificationDecision): void;
    onError?(error: unknown): void;
    openInbox(): Promise<void>;
    showNotification(
        notification: AgentSystemNotification,
        onClick: () => void,
    ): AgentSystemNotificationHandle | undefined;
}

export interface BotInboxNotificationCoordinator {
    dispose(): void;
    flush(): Promise<void>;
    /**
     * Records the items already open at launch, so a restart never replays what the owner has already been told.
     */
    initialize(): Promise<void>;
    observe(event: ServerEvent): void;
}

const NOTIFICATION_ID = 'caxri-bot-inbox';

/**
 * Notification copy for the items Caxri Bot just raised. One item reads as its own title; a burst collapses into a
 * count so the owner gets one banner, not one per item.
 */
export function botInboxNotificationText(items: ReadonlyArray<Pick<BotInboxItem, 'title'>>): {
    body: string;
    title: string;
} {
    return {
        title: translateMain('desktop.notification.botInbox.title'),
        body:
            items.length === 1
                ? items[0].title
                : translateMain('desktop.notification.botInbox.bodyOther', {
                      count: items.length,
                  }),
    };
}

/**
 * Picks the open items that were not open the last time the Inbox was read. Only `open` items count: a closed item
 * needs nothing from the owner, and a reopened update of an existing item keeps its id, so it is not news.
 */
function newlyOpenedInboxItems(
    seen: ReadonlySet<string>,
    items: readonly BotInboxItem[],
): BotInboxItem[] {
    return items.filter((item) => item.status === 'open' && !seen.has(item.id));
}

/**
 * Raises a system notification when Caxri Bot adds a new open Inbox item, which is otherwise visible only inside Caxri
 * Bot's window and the status-bar chip. It follows the Agent notification setting, so one switch silences every
 * Agent-originated banner.
 */
export function createBotInboxNotificationCoordinator(
    options: BotInboxNotificationOptions,
): BotInboxNotificationCoordinator {
    let isDisposed = false;
    let isInitialized = false;
    let tail = Promise.resolve();
    const seen = new Set<string>();
    let handle: AgentSystemNotificationHandle | undefined;

    const schedule = (task: () => Promise<void>): void => {
        const previous = tail;
        tail = (async () => {
            try {
                await previous;
                if (isDisposed) return;
                await task();
            } catch (error) {
                options.onError?.(error);
            }
        })();
    };

    const remember = (items: readonly BotInboxItem[]): void => {
        seen.clear();
        for (const item of items) if (item.status === 'open') seen.add(item.id);
    };

    const refresh = async (): Promise<void> => {
        const items = await options.loadInbox();
        if (!isInitialized) {
            remember(items);
            isInitialized = true;
            return;
        }
        const fresh = newlyOpenedInboxItems(seen, items);
        remember(items);
        if (fresh.length === 0) return;
        const settings = await options.loadSettings();
        const outcome: BotInboxNotificationOutcome = !settings['agents.notifications.enabled']
            ? 'disabled'
            : options.isBotFocused()
              ? 'botFocused'
              : 'shown';
        options.onDecision?.({ itemCount: fresh.length, outcome });
        if (outcome !== 'shown') return;
        handle?.close();
        handle = options.showNotification(
            {
                id: NOTIFICATION_ID,
                groupId: NOTIFICATION_ID,
                ...botInboxNotificationText(fresh),
            },
            () => {
                schedule(() => options.openInbox());
            },
        );
    };

    return {
        dispose: () => {
            isDisposed = true;
            handle?.close();
            handle = undefined;
        },
        flush: () => tail,
        initialize: async () => {
            schedule(refresh);
            await tail;
        },
        observe: (event) => {
            if (event.event !== 'botInbox.changed') return;
            schedule(refresh);
        },
    };
}
