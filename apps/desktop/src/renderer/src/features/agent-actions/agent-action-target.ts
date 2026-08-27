export type AgentActionTargetTitle =
    | { kind: 'shared'; title: string }
    | { kind: 'distinct'; sessionTitle: string; terminalTitle: string };

function normalizedTitle(title: string | undefined, fallback: string): string {
    const normalized = title?.trim();
    return normalized && normalized.length > 0 ? normalized : fallback;
}

export function resolveAgentActionTargetTitle(
    sessionTitle: string | undefined,
    terminalTitle: string | undefined,
): AgentActionTargetTitle {
    const normalizedSessionTitle = normalizedTitle(sessionTitle, 'Session');
    const normalizedTerminalTitle = normalizedTitle(terminalTitle, 'Terminal');
    if (normalizedSessionTitle === normalizedTerminalTitle)
        return { kind: 'shared', title: normalizedSessionTitle };
    return {
        kind: 'distinct',
        sessionTitle: normalizedSessionTitle,
        terminalTitle: normalizedTerminalTitle,
    };
}

export function describeAgentActionTarget(
    providerName: string,
    target: AgentActionTargetTitle,
): string {
    return target.kind === 'shared'
        ? `Target: ${providerName}; ${target.title}`
        : `Target: ${providerName}; Session: ${target.sessionTitle}; Terminal: ${target.terminalTitle}`;
}
