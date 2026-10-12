import { notifyListeners } from '@caxri/utils';

import type { AgentChatTimelineEntry, AgentChatWorkItem } from './agent-chat-timeline';

/**
 * Disclosure keys for the rows of one Chat timeline. A work row is keyed by its item, so it keeps its state when the
 * item moves from a live row into a summary group; a summary group by its first item; a finished turn by the turn.
 */
export const agentChatItemExpansionKey = (itemId: string): string => `item:${itemId}`;
export const agentChatSummaryExpansionKey = (items: readonly AgentChatWorkItem[]): string =>
    `summary:${items.at(0)?.id ?? ''}`;
export const agentChatTurnExpansionKey = (entryId: string): string => entryId;

/**
 * Which timeline rows the user expanded or collapsed, owned by the Chat pane rather than by each row. The timeline
 * rebuilds its rows as a turn runs and ends (a live row merges into a summary group, a finished turn folds), which
 * remounts them; state kept here survives that, so what the user opened stays open. Only explicit choices are stored: a
 * row nobody touched takes its default.
 */
export class AgentChatExpansionState {
    private readonly expanded = new Map<string, boolean>();
    private readonly listeners = new Set<() => void>();

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    /**
     * The user's explicit choice for `key`, or `undefined` when they never toggled it.
     */
    get(key: string): boolean | undefined {
        return this.expanded.get(key);
    }

    set(key: string, isExpanded: boolean): void {
        if (this.expanded.get(key) === isExpanded) return;
        this.expanded.set(key, isExpanded);
        // One throwing row must not keep the other subscribed rows from seeing the user's choice; Desktop mirrors
        // `console.error` into `logs/desktop.jsonl`.
        notifyListeners(this.listeners, undefined, (error) =>
            console.error('agentChat.expansion listener failed', error),
        );
    }

    /**
     * Whether the user expanded any of `items` themselves, which opens the group or turn holding them by default.
     */
    hasExpandedItem(items: readonly AgentChatWorkItem[]): boolean {
        return items.some((item) => this.expanded.get(agentChatItemExpansionKey(item.id)) === true);
    }
}

/**
 * Every work item a finished turn folded away, so the fold opens by default when the user had expanded one of them
 * while the turn ran (the turn ending must not hide what they were reading).
 */
export function agentChatTurnWorkItems(
    entry: Extract<AgentChatTimelineEntry, { kind: 'turn' }>,
): AgentChatWorkItem[] {
    return entry.entries.flatMap((child) => (child.kind === 'work' ? child.items : []));
}

/**
 * A disclosure's state: the user's explicit choice when there is one, else its default.
 */
export function isAgentChatExpanded(
    explicit: boolean | undefined,
    isDefaultExpanded: boolean,
): boolean {
    return explicit ?? isDefaultExpanded;
}
