import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';
import { agentChatTimelineEntryKey } from '../transcript/agent-chat-timeline';

/**
 * Where the "You took over" divider goes in the child's timeline: before the entry with this key, or as a standalone
 * marker after the last entry (just above the composer) when the timeline cannot place it.
 */
export type TakeoverDividerPlacement =
    { entryKey: string; kind: 'before' } | { kind: 'standalone' };

/**
 * When an entry's first item arrived, or `undefined` when it has none to tell. A folded turn answers for its first
 * child; a stopped turn's empty fold row and the artifacts after a reply carry no time of their own and are skipped.
 */
function entryTime(entry: AgentChatTimelineEntry): number | undefined {
    switch (entry.kind) {
        case 'item': {
            return entry.item.createdAt;
        }
        case 'work': {
            return entry.items[0]?.createdAt;
        }
        case 'turn': {
            for (const child of entry.entries) {
                const time = entryTime(child);
                if (time !== undefined) return time;
            }
            return undefined;
        }
        case 'artifacts': {
            return undefined;
        }
    }
}

/**
 * Whether the entry has no item to date (an empty stopped-turn row, or artifacts), so it neither proves nor disproves
 * that the takeover came before it.
 */
function isUndated(entry: AgentChatTimelineEntry): boolean {
    return entry.kind === 'artifacts' || (entry.kind === 'turn' && entry.entries.length === 0);
}

/**
 * Places the divider at the first entry that arrived at or after the takeover. It never guesses: when an entry before
 * that point has no time (a replayed history carries none), when the only earlier items were never read back
 * (`isHistoryComplete` false and the first entry is already after the takeover, so the takeover may sit in the part not
 * loaded), or when nothing arrived since (Stop or Rewind with no output yet), the divider is a standalone marker above
 * the composer instead.
 */
export function takeoverDividerPlacement(
    timeline: readonly AgentChatTimelineEntry[],
    takenOverAt: number,
    isHistoryComplete: boolean,
): TakeoverDividerPlacement {
    let isFirst = true;
    for (const entry of timeline) {
        if (isUndated(entry)) continue;
        const time = entryTime(entry);
        if (time === undefined) return { kind: 'standalone' };
        if (time >= takenOverAt)
            return isFirst && !isHistoryComplete
                ? { kind: 'standalone' }
                : { entryKey: agentChatTimelineEntryKey(entry), kind: 'before' };
        isFirst = false;
    }
    return { kind: 'standalone' };
}
