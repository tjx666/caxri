/**
 * Virtual editor tab for one Agent Terminal's status: its output speed in detail and the public status of the
 * provider's services. Identity is the Terminal, so each Agent gets its own tab; the provider is resolved from the
 * Terminal at render time, never stored in the path.
 */
const AGENT_STATUS_TAB_PREFIX = 'caxri-agent-status://';

export function agentStatusTabPath(terminalId: string): string {
    return `${AGENT_STATUS_TAB_PREFIX}${encodeURIComponent(terminalId)}`;
}

export function parseAgentStatusTab(path: string): { terminalId: string } | undefined {
    if (!path.startsWith(AGENT_STATUS_TAB_PREFIX)) return undefined;
    const encoded = path.slice(AGENT_STATUS_TAB_PREFIX.length);
    if (!encoded || encoded.includes('/')) return undefined;
    try {
        return { terminalId: decodeURIComponent(encoded) };
    } catch {
        return undefined;
    }
}

export function isAgentStatusTabPath(path: string): boolean {
    return Boolean(parseAgentStatusTab(path));
}

/**
 * `Codex Status` once the Terminal's Agent is known, `Agent Status` before.
 */
export function agentStatusTabLabel(agentName: string | undefined): string {
    return `${agentName ?? 'Agent'} Status`;
}
