import type { AgentChatWorkItem } from '@caxri/protocol';
import { mergeAgentChatReasoning, splitAgentChatWork } from '@caxri/protocol';

/**
 * A run of consecutive work in the Chat timeline (`buildAgentChatTimeline`).
 */
export interface AgentChatWorkEntry {
    kind: 'work';
    id: string;
    /**
     * The running turn's trailing work, which the next tool call can still join. Its summary names the current step and
     * stays marked running between calls, as on Desktop; the aggregate replaces it once the run ends.
     */
    isOpen?: true;
    /**
     * Every item of the run, before thoughts merge, so the list can keep the row's id when an older page adds items in
     * front of it (`agentChatFormerEntryIds`).
     */
    itemIds: readonly string[];
    summarized: readonly AgentChatWorkItem[];
    rows: readonly AgentChatWorkItem[];
}

const agentChatWorkEntryId = (itemId: string): string => `work:${itemId}`;

/**
 * A run of consecutive work as the timeline's `work` entry, without its `kind`. Back-to-back thoughts merge into one
 * row titled by the latest, and independent tasks keep their own rows (`splitAgentChatWork`). Once the run settles, a
 * summary of one call adds nothing over the call itself, so that call becomes its own row, as on Desktop. The running
 * turn's trailing run (`isOpen`) keeps its summary, so a second call joining it does not reshape the row.
 */
export function agentChatWorkEntry(
    work: readonly AgentChatWorkItem[],
    taskItemIds: ReadonlySet<string>,
    isOpen: boolean,
): Omit<AgentChatWorkEntry, 'kind'> | undefined {
    const first = work.at(0);
    if (!first) return undefined;
    const split = splitAgentChatWork(mergeAgentChatReasoning(work), (item) =>
        taskItemIds.has(item.id),
    );
    const isSingle = !isOpen && split.summarized.length === 1;
    return {
        id: agentChatWorkEntryId(first.id),
        itemIds: work.map((item) => item.id),
        ...(isOpen && { isOpen: true as const }),
        summarized: isSingle ? [] : split.summarized,
        rows: isSingle ? [...split.summarized, ...split.rows] : split.rows,
    };
}

/**
 * The ids a timeline row may have been drawn under before, for `stabilizeAgentChatEntries`. A work run is keyed by its
 * first item, so a run an older page extends at its front (the page boundary split it) gets a new id; FlashList then
 * lost the row it anchors the scroll position on, and a scroll-back that read several pages jumped page after page to
 * the oldest history. Any item of the run names the id it may have had.
 */
export function agentChatFormerEntryIds(entry: {
    kind: string;
    itemIds?: readonly string[];
}): readonly string[] {
    return entry.kind === 'work' && entry.itemIds ? entry.itemIds.map(agentChatWorkEntryId) : [];
}
