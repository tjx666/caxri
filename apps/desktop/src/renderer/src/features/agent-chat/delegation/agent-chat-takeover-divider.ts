import type { DelegationControlChange } from '@caxri/protocol';

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

/**
 * Where each control-change divider goes: the changes before each entry key, oldest first, and the one change that has
 * no entry to precede and sits above the composer instead.
 */
export interface ControlDividerPlacements {
    before: ReadonlyMap<string, readonly DelegationControlChange[]>;
    standalone: DelegationControlChange | undefined;
}

export const NO_CONTROL_DIVIDERS: ControlDividerPlacements = {
    before: new Map(),
    standalone: undefined,
};

/**
 * Places a divider for every time the Session changed hands (see {@link takeoverDividerPlacement} for one). Only the
 * newest change may fall back to the standalone marker above the composer, since it says who holds the Session now; an
 * older change the timeline cannot place is left out rather than stacked there out of order.
 */
export function controlDividerPlacements(
    timeline: readonly AgentChatTimelineEntry[],
    changes: readonly DelegationControlChange[],
    isHistoryComplete: boolean,
): ControlDividerPlacements {
    const before = new Map<string, DelegationControlChange[]>();
    let standalone: DelegationControlChange | undefined;
    for (const [index, change] of changes.entries()) {
        const placement = takeoverDividerPlacement(timeline, change.at, isHistoryComplete);
        if (placement.kind === 'before') {
            const list = before.get(placement.entryKey) ?? [];
            list.push(change);
            before.set(placement.entryKey, list);
        } else if (index === changes.length - 1) standalone = change;
    }
    return { before, standalone };
}
