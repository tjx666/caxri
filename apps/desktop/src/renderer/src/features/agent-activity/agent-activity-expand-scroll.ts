import type { AgentActivityGroupId } from './agent-activity-rows';

/**
 * Where the Activity scroller should move after the user opens a group, or `undefined` to stay put. Offsets are in the
 * scroller's content coordinates.
 *
 * Opening a group near the bottom otherwise changes nothing the user can see: the heading flips its chevron and every
 * revealed row lands below the fold. So the group scrolls up just far enough to show its last row, but never past its
 * own heading: a group taller than the viewport pins the heading to the top instead, so the user still sees which group
 * they opened and its first rows. A group already fully visible never moves the list.
 */
export function expandedAgentActivityGroupScrollTop({
    groupBottom,
    groupTop,
    scrollTop,
    viewportHeight,
}: {
    groupBottom: number;
    groupTop: number;
    scrollTop: number;
    viewportHeight: number;
}): number | undefined {
    if (groupBottom <= scrollTop + viewportHeight) return undefined;
    const target = Math.min(groupBottom - viewportHeight, groupTop);
    return target > scrollTop ? target : undefined;
}

/**
 * Brings a just-opened Activity group into view (`expandedAgentActivityGroupScrollTop`). Call it after the expanded
 * rows are committed. The group spans its heading through the last sibling before the next heading, which includes a
 * trailing "Show more" row.
 */
export function scrollExpandedAgentActivityGroupIntoView(
    scroller: HTMLElement,
    groupId: AgentActivityGroupId,
): void {
    const heading = scroller.querySelector<HTMLElement>(
        `.agent-activity-heading[data-row-id="${CSS.escape(groupId)}"]`,
    );
    if (!heading) return;
    let last: Element = heading;
    while (
        last.nextElementSibling &&
        !last.nextElementSibling.classList.contains('agent-activity-heading')
    )
        last = last.nextElementSibling;
    const contentTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const top = expandedAgentActivityGroupScrollTop({
        groupBottom: last.getBoundingClientRect().bottom - contentTop,
        groupTop: heading.getBoundingClientRect().top - contentTop,
        scrollTop: scroller.scrollTop,
        viewportHeight: scroller.clientHeight,
    });
    if (top !== undefined) scroller.scrollTo({ behavior: 'smooth', top });
}
