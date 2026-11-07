import { checkBounds, waitForCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * Brings a Session's row on screen after the app relaunches on a tablet display, so `session-row-<id>` can be tapped.
 * The Session list pages by Project, and the semantics keep only the first node per id. On a tablet layout that first
 * row belongs to the Project's own page, parked off screen beside the "All" page, so its bounds are empty and the tap
 * helper refuses it. Showing the Project's page brings that row on screen.
 */
export async function showTabletSessionRow(
    serial: string,
    projectId: string,
    sessionId: string,
): Promise<void> {
    const projectFilter = `project-filter-${projectId}`;
    await waitForCheck(serial, projectFilter, 60_000);
    await tapMobileCheck(serial, projectFilter);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => checkBounds(nodes, `session-row-${sessionId}`) !== undefined,
    );
}
