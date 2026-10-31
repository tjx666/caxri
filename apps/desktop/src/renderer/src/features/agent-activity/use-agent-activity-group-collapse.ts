import { useCallback, useEffect, useMemo, useState } from 'react';

import { SESSION_ACTIVITY_GROUP_ORDER } from '@caxri/protocol';

import { usePinnedCollapse } from '../primary-sidebar/hooks/use-pinned-collapse';
import type { AgentActivityGroupId } from './agent-activity-rows';

const STORAGE_KEY = 'caxri.agent-activity-collapsed-groups';

type StatusGroupId = Exclude<AgentActivityGroupId, 'pinned'>;

const STATUS_GROUP_IDS: ReadonlySet<string> = new Set(SESSION_ACTIVITY_GROUP_ORDER);

function isBrowser(): boolean {
    // DOM types declare these globals as always present, but this module also loads in Vitest's Node environment.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    return typeof window !== 'undefined' && globalThis.localStorage !== undefined;
}

function readCollapsedStatusGroups(): StatusGroupId[] {
    if (!isBrowser()) return [];
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
        return Array.isArray(parsed)
            ? parsed.filter((id): id is StatusGroupId => STATUS_GROUP_IDS.has(id as string))
            : [];
    } catch {
        return [];
    }
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
    const [collapsedStatusGroups, setCollapsedStatusGroups] =
        useState<StatusGroupId[]>(readCollapsedStatusGroups);
    useEffect(() => {
        if (!isBrowser()) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedStatusGroups));
        } catch {
            // Storage-disabled windows keep the disclosure state for this Renderer lifetime.
        }
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
