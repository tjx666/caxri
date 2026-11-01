import type { AgentActivityGroupId } from './agent-activity-rows';

/**
 * The groups whose rows ask the user to act, so a hidden arrival there must not stay hidden.
 */
const AUTO_EXPAND_GROUP_IDS: ReadonlySet<AgentActivityGroupId> = new Set(['attention', 'failed']);

/**
 * Which collapsed groups to reopen because their count rose since the last look. Only "Needs attention" and "Failed"
 * qualify: a collapsed queue is the user's choice, but it must not hide a new Session that is waiting on them across
 * launches. The first observation (`undefined`) never reopens, so a remembered collapse survives a relaunch until
 * something actually arrives. That is deliberate and deterministic: the first effect run may see a still-loading empty
 * map, so reopening on first sight would be flaky; across a relaunch the visible count badge on the collapsed heading
 * is the signal; afterwards a group that was absent counts as zero, so a brand-new group reopens too.
 */
export function groupsToAutoExpand(
    previousCounts: ReadonlyMap<AgentActivityGroupId, number> | undefined,
    currentCounts: ReadonlyMap<AgentActivityGroupId, number>,
    collapsedGroupIds: ReadonlySet<AgentActivityGroupId>,
): AgentActivityGroupId[] {
    const reopen: AgentActivityGroupId[] = [];
    for (const [groupId, count] of currentCounts) {
        if (!AUTO_EXPAND_GROUP_IDS.has(groupId) || !collapsedGroupIds.has(groupId)) continue;
        if (previousCounts && count > (previousCounts.get(groupId) ?? 0)) reopen.push(groupId);
    }
    return reopen;
}
