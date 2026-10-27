import { translate } from '../../i18n';
import type { SessionStatusSummary } from './session-status';

/**
 * Pure presentation copy for the PrimarySidebar's Project heading row. Kept out of `ProjectGroup` so the wording and
 * its pluralization are covered by fast unit tests instead of an Electron E2E workflow (see the `unit-testing` skill).
 */

/**
 * Accessible name for a Project heading. The heading renders its Session count as a decorative digit next to the title,
 * so the count has to be named here; otherwise assistive technology either loses it entirely or reads the title
 * followed by a bare number with nothing saying what was counted. A collapsed heading also draws a decorative Agent
 * summary (running arc, count, attention dot), which is named the same way.
 */
export function describeProjectSessionCount(
    title: string,
    sessionCount: number,
    agentSummary?: SessionStatusSummary,
): string {
    const name = translate(
        sessionCount === 1
            ? 'primarySidebar.projectHeading.nameOne'
            : 'primarySidebar.projectHeading.nameOther',
        { count: sessionCount, title },
    );
    const agentStatus = agentSummary && describeProjectAgentStatus(agentSummary);
    return agentStatus
        ? translate('primarySidebar.projectHeading.withStatus', { name, status: agentStatus })
        : name;
}

function describeProjectAgentStatus({
    attention,
    running,
}: SessionStatusSummary): string | undefined {
    const parts = [
        running > 0 && translate('primarySidebar.projectHeading.running', { count: running }),
        attention > 0 &&
            translate(
                attention === 1
                    ? 'primarySidebar.projectHeading.attentionOne'
                    : 'primarySidebar.projectHeading.attentionOther',
                { count: attention },
            ),
    ].filter(Boolean);
    return parts.length > 0
        ? parts.join(translate('primarySidebar.projectHeading.separator'))
        : undefined;
}
