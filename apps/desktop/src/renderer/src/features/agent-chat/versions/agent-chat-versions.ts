import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentChatVersionContent,
    AgentChatVersionSummary,
} from '@caxri/protocol';

/**
 * Which earlier versions of a Chat's conversation the timeline shows: "Edit from here" keeps the turns it replaced
 * (`agentChat.listVersions`), and the edited message's switcher swaps everything from that message on for one of them.
 * Earlier versions are read-only; the conversation always continues on the current one. See `docs/agent-chat.md`.
 */

/**
 * Names one switch point: the earlier version whose content holds it (`''` for the conversation that continues) and the
 * turn the versions branch after (`''` for the conversation's start).
 */
export function agentChatVersionKey(parentVersionId: string | null, anchorTurnId: string | null) {
    return `${parentVersionId ?? ''}\u{0}${anchorTurnId ?? ''}`;
}

/**
 * The earlier versions at each switch point, oldest first.
 */
export function agentChatVersionGroups(
    summaries: readonly AgentChatVersionSummary[],
): ReadonlyMap<string, readonly AgentChatVersionSummary[]> {
    const groups = new Map<string, AgentChatVersionSummary[]>();
    for (const summary of summaries) {
        const key = agentChatVersionKey(summary.parentVersionId, summary.anchorTurnId);
        groups.set(key, [...(groups.get(key) ?? []), summary]);
    }
    return groups;
}

/**
 * The switcher one user message shows: `index` is the version on screen, 0-based and oldest first, and the last of the
 * `count` versions is the one the content around it continues (for the conversation itself, the current version).
 */
export interface AgentChatVersionSwitcher {
    key: string;
    index: number;
    count: number;
    /**
     * The version at each index, `undefined` for the last one.
     */
    versionIds: ReadonlyArray<string | undefined>;
}

/**
 * The version picked at each switch point; a switch point absent from it shows its last version.
 */
export type AgentChatVersionSelection = ReadonlyMap<string, string>;

export interface AgentChatVersionView {
    items: AgentChatItem[];
    turns: AgentChatTurn[];
    /**
     * The switcher on each user message that has earlier versions, by item id.
     */
    switchers: ReadonlyMap<string, AgentChatVersionSwitcher>;
    /**
     * Items on screen that belong to an earlier version, which offer no Edit, Fork, or Restore code.
     */
    earlierItemIds: ReadonlySet<string>;
    /**
     * Whether an earlier version replaces part of the conversation on screen.
     */
    isViewingEarlier: boolean;
    /**
     * The version ids the view needs and has not received yet.
     */
    missing: readonly string[];
}

interface Content {
    items: readonly AgentChatItem[];
    turns: readonly AgentChatTurn[];
}

/**
 * The position of the user message that starts each turn.
 */
function turnStarts(items: readonly AgentChatItem[]): Map<string, number> {
    const starts = new Map<string, number>();
    for (const [index, item] of items.entries())
        if (item.type === 'userMessage' && item.turnId !== undefined && !starts.has(item.turnId))
            starts.set(item.turnId, index);
    return starts;
}

/**
 * Lays out what the timeline shows: `base` (the live projection) with the earliest selected switch point's tail swapped
 * for that version's content, recursively, so a version kept inside another one switches too. `isFromStart` says `base`
 * holds the conversation from its first turn, without which a version of the first message has nowhere to sit. A
 * selected version whose content has not arrived keeps the current one on screen and lists it in `missing`.
 */
export function agentChatVersionView(
    base: Content,
    isFromStart: boolean,
    groups: ReadonlyMap<string, readonly AgentChatVersionSummary[]>,
    selection: AgentChatVersionSelection,
    contents: ReadonlyMap<string, AgentChatVersionContent>,
): AgentChatVersionView {
    const switchers = new Map<string, AgentChatVersionSwitcher>();
    const earlierItemIds = new Set<string>();
    const missing: string[] = [];
    let isViewingEarlier = false;

    const walk = (
        content: Content,
        parentVersionId: string | null,
        incoming: AgentChatVersionSwitcher | undefined,
    ): { items: AgentChatItem[]; turns: AgentChatTurn[] } => {
        const { items, turns } = content;
        const starts = turnStarts(items);
        for (const [index, turn] of turns.entries()) {
            const cut = starts.get(turn.id);
            if (cut === undefined) continue;
            const messageId = items[cut].id;
            if (index === 0 && incoming) {
                switchers.set(messageId, incoming);
                continue;
            }
            if (index === 0 && (parentVersionId !== null || !isFromStart)) continue;
            const key = agentChatVersionKey(
                parentVersionId,
                index === 0 ? null : turns[index - 1].id,
            );
            const group = groups.get(key);
            if (!group?.length) continue;
            const versionIds = [...group.map((version) => version.id), undefined];
            const picked = group.findIndex((version) => version.id === selection.get(key));
            const switcher = {
                key,
                index: picked === -1 ? group.length : picked,
                count: versionIds.length,
                versionIds,
            };
            const versionId = picked === -1 ? undefined : group[picked].id;
            const picks = versionId === undefined ? undefined : contents.get(versionId);
            if (versionId !== undefined && !picks) missing.push(versionId);
            if (versionId === undefined || !picks) {
                switchers.set(messageId, switcher);
                continue;
            }
            isViewingEarlier = true;
            const tail = walk(picks, versionId, switcher);
            for (const item of tail.items) earlierItemIds.add(item.id);
            return {
                items: [...items.slice(0, cut), ...tail.items],
                turns: [...turns.slice(0, index), ...tail.turns],
            };
        }
        return { items: [...items], turns: [...turns] };
    };

    const { items, turns } = walk(base, null, undefined);
    return { items, turns, switchers, earlierItemIds, isViewingEarlier, missing };
}

/**
 * The snapshot the timeline renders for a view: a running turn belongs to the current version, so an earlier one on
 * screen shows none.
 */
export function agentChatSnapshotWithVersions(
    snapshot: AgentChatSnapshot,
    view: AgentChatVersionView,
): AgentChatSnapshot {
    if (!view.isViewingEarlier) return snapshot;
    return { ...snapshot, items: view.items, turns: view.turns, activeTurnId: undefined };
}

/**
 * The selection after the user steps a switcher to `index`: the last version clears the switch point, and so does every
 * switch point inside the version it leaves, so coming back shows that version's own continuation.
 */
export function selectAgentChatVersion(
    selection: AgentChatVersionSelection,
    switcher: AgentChatVersionSwitcher,
    index: number,
): AgentChatVersionSelection {
    const next = new Map(selection);
    const left = selection.get(switcher.key);
    if (left !== undefined)
        for (const key of next.keys()) if (key.startsWith(`${left}\u{0}`)) next.delete(key);
    const versionId = switcher.versionIds[index];
    if (versionId === undefined) next.delete(switcher.key);
    else next.set(switcher.key, versionId);
    return next;
}
