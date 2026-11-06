import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { scrollExpandedAgentActivityGroupIntoView } from '../agent-activity-expand-scroll';
import type { AgentActivityGroupId } from '../agent-activity-rows';

/**
 * Scrolls a group the user just opened by hand into view once its rows are in the DOM. Returns the call the heading's
 * toggle makes before expanding. Only a user toggle marks a group: an automatic reopen (`useAgentActivityAutoExpand`)
 * or a rename reveal must not move the list under the user.
 *
 * @param scrollReference The Activity list's scroller.
 * @param rows The rendered tree rows; a new array marks the commit that inserted the expanded group's rows.
 */
export function useAgentActivityExpandScroll(
    scrollReference: RefObject<HTMLElement | null>,
    rows: unknown,
): (groupId: AgentActivityGroupId) => void {
    const pendingGroupReference = useRef<AgentActivityGroupId | undefined>(undefined);
    useLayoutEffect(() => {
        const groupId = pendingGroupReference.current;
        if (!groupId || !scrollReference.current) return;
        pendingGroupReference.current = undefined;
        scrollExpandedAgentActivityGroupIntoView(scrollReference.current, groupId);
    }, [rows, scrollReference]);
    return (groupId) => {
        pendingGroupReference.current = groupId;
    };
}
