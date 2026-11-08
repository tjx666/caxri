import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SESSION_ACTIVITY_GROUP_ORDER } from '@caxri/protocol';

import { createSharedLocalState } from '../../../lib/local-storage';
import { usePinnedCollapse } from '../../primary-sidebar/hooks/use-pinned-collapse';
import { groupsToAutoExpand } from '../agent-activity-auto-expand';
import type { AgentActivityGroupId } from '../agent-activity-rows';

/**
 * A record `{ [groupId]: true }` rather than a list, so two windows that collapse different groups each patch their own
 * field instead of overwriting one list. An older list-shaped entry is not a record and reads as nothing collapsed.
 */
const STORAGE_KEY = 'caxri.agent-activity-collapsed-groups';

type StatusGroupId = Exclude<AgentActivityGroupId, 'pinned'>;

const STATUS_GROUP_IDS: ReadonlySet<string> = new Set(SESSION_ACTIVITY_GROUP_ORDER);

function parseCollapsedStatusGroups(raw: unknown): StatusGroupId[] {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
    return Object.entries(raw)
        .filter(([id, isCollapsed]) => isCollapsed === true && STATUS_GROUP_IDS.has(id))
        .map(([id]) => id as StatusGroupId);
}

/**
 * Shared by every window of the profile (docs/client-local-data.md).
 */
const sharedCollapsedGroups = createSharedLocalState(STORAGE_KEY, parseCollapsedStatusGroups);

/**
 * The groups whose collapsed state differs between this window and the stored record, as the fields to patch.
 */
function collapsedGroupChanges(
    persisted: readonly StatusGroupId[],
    current: readonly StatusGroupId[],
): Record<string, true | undefined> {
    const before = new Set(persisted);
    const after = new Set(current);
    const changes: Record<string, true | undefined> = {};
    for (const id of after.difference(before)) changes[id] = true;
    for (const id of before.difference(after)) changes[id] = undefined;
    return changes;
}

/**
 * Which Activity groups the user collapsed, remembered across launches like the Project tree's disclosures. Every group
 * starts open: the queue exists to show these rows, so hiding one has to be the user's choice.
 *
 * Pinned keeps the Project tree Pinned group's own record (`usePinnedCollapse`): both bodies show the same pinned
 * Sessions, so collapsing them in one and finding them open in the other would read as two different features.
 */
export function useAgentActivityGroupCollapse(): {
    collapsedGroupIds: ReadonlySet<AgentActivityGroupId>;
    expand: (groupId: AgentActivityGroupId) => void;
    toggle: (groupId: AgentActivityGroupId) => void;
} {
    const pinned = usePinnedCollapse();
    // Kept as component state, not a store: the auto-expand hook below reopens a group during render, which may only
    // touch this component's own state.
    const [collapsedStatusGroups, setCollapsedStatusGroups] = useState<StatusGroupId[]>(
        sharedCollapsedGroups.read,
    );
    const persisted = useRef(collapsedStatusGroups);
    // Another window's change lands in memory only; `persisted` moves with it so the effect below finds no difference
    // and never writes it back.
    useEffect(
        () =>
            sharedCollapsedGroups.subscribe((groups) => {
                persisted.current = groups;
                setCollapsedStatusGroups(groups);
            }),
        [],
    );
    // Patches only the groups this window changed, so a group collapsed in another window meanwhile stays collapsed.
    useEffect(() => {
        const changes = collapsedGroupChanges(persisted.current, collapsedStatusGroups);
        if (Object.keys(changes).length === 0) return;
        persisted.current = sharedCollapsedGroups.patch(changes);
    }, [collapsedStatusGroups]);
    const collapsedGroupIds = useMemo(
        () =>
            new Set<AgentActivityGroupId>(
                pinned.expanded ? collapsedStatusGroups : ['pinned', ...collapsedStatusGroups],
            ),
        [collapsedStatusGroups, pinned.expanded],
    );
    const { expand: expandPinned, toggle: togglePinned } = pinned;
    const toggle = useCallback(
        (groupId: AgentActivityGroupId) => {
            if (groupId === 'pinned') {
                togglePinned();
                return;
            }
            setCollapsedStatusGroups((current) =>
                current.includes(groupId)
                    ? current.filter((id) => id !== groupId)
                    : [...current, groupId],
            );
        },
        [togglePinned],
    );
    // For commands that must put a Session's row on screen before acting on it, such as `session.rename`.
    const expand = useCallback(
        (groupId: AgentActivityGroupId) => {
            if (groupId === 'pinned') {
                expandPinned();
                return;
            }
            setCollapsedStatusGroups((current) => current.filter((id) => id !== groupId));
        },
        [expandPinned],
    );
    return { collapsedGroupIds, expand, toggle };
}

/**
 * Reopens a collapsed "Needs attention" group when its count rises, so a Session that just arrived is not hidden.
 * Counts come from the headings so the rule follows the number the user sees; `groupsToAutoExpand` owns the rule
 * itself.
 */
export function useAgentActivityAutoExpand(
    headings: ReadonlyMap<AgentActivityGroupId, { count?: number }>,
    collapsedGroupIds: ReadonlySet<AgentActivityGroupId>,
    expandGroup: (groupId: AgentActivityGroupId) => void,
): void {
    // Adjusted during render rather than in an effect (React's "storing information from previous renders"): the
    // expansion lands in the same commit as the count that caused it. `expandGroup` only reopens "Needs attention",
    // whose state is this component's own `useState`, so the update stays local.
    const [observed, setObserved] = useState<{
        counts?: ReadonlyMap<AgentActivityGroupId, number>;
        headings?: ReadonlyMap<AgentActivityGroupId, { count?: number }>;
    }>({});
    if (observed.headings !== headings) {
        const counts = new Map<AgentActivityGroupId, number>();
        for (const [groupId, heading] of headings) counts.set(groupId, heading.count ?? 0);
        for (const groupId of groupsToAutoExpand(observed.counts, counts, collapsedGroupIds))
            expandGroup(groupId);
        setObserved({ counts, headings });
    }
}
