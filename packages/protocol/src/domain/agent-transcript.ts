/**
 * Virtual editor tab for viewing an Agent Terminal's on-disk transcript. The encoded string is stored as a plain tab
 * path (like `git-diff.ts` tabs), so it persists and restores without any special casing; the Runtime resolves the
 * terminal's current transcript file at read time.
 *
 * Tab identity is the terminal ID alone: the stable semantic title is resolved from the Terminal record at render time,
 * so a provider switch can update the label without creating a duplicate tab while PTY window titles cannot rename it.
 */
export interface AgentTranscriptTab {
    terminalId: string;
}

const AGENT_TRANSCRIPT_TAB_PREFIX = 'caxri-agent-transcript://';

export function agentTranscriptTabPath(terminalId: string): string {
    return `${AGENT_TRANSCRIPT_TAB_PREFIX}${encodeURIComponent(terminalId)}`;
}

export function parseAgentTranscriptTab(path: string): AgentTranscriptTab | undefined {
    if (!path.startsWith(AGENT_TRANSCRIPT_TAB_PREFIX)) return undefined;
    // Everything after the first `/` (the legacy title segment) is ignored so previously
    // persisted title-bearing paths keep resolving to the same terminal.
    const [encodedTerminalId] = path.slice(AGENT_TRANSCRIPT_TAB_PREFIX.length).split('/', 1);
    if (!encodedTerminalId) return undefined;
    try {
        return { terminalId: decodeURIComponent(encodedTerminalId) };
    } catch {
        return undefined;
    }
}

export function isAgentTranscriptTabPath(path: string): boolean {
    return Boolean(parseAgentTranscriptTab(path));
}
