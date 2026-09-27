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
    displayTitle: string,
    sessionCount: number,
    agentSummary?: SessionStatusSummary,
): string {
    const name = `${displayTitle} (${sessionCount} ${sessionCount === 1 ? 'Session' : 'Sessions'})`;
    const agentStatus = agentSummary && describeProjectAgentStatus(agentSummary);
    return agentStatus ? `${name}, ${agentStatus}` : name;
}

function describeProjectAgentStatus({
    attention,
    running,
}: SessionStatusSummary): string | undefined {
    const parts = [
        running > 0 && `${running} running`,
        attention > 0 && `${attention} ${attention === 1 ? 'needs' : 'need'} attention`,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : undefined;
}
