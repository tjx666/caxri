/**
 * Virtual editor tab reviewing one Agent Chat turn's file changes as a single diff. Like the task tab, the encoded
 * string is a plain tab path, so it persists and restores without special casing; the Renderer reads the turn's changes
 * from the Chat's projection each time the tab mounts.
 */
export interface AgentTurnReviewTab {
    terminalId: string;
    turnId: string;
}

const AGENT_TURN_REVIEW_TAB_PREFIX = 'caxri-agent-turn-review://';

export function agentTurnReviewTabPath(terminalId: string, turnId: string): string {
    return `${AGENT_TURN_REVIEW_TAB_PREFIX}${encodeURIComponent(terminalId)}/${encodeURIComponent(turnId)}`;
}

export function parseAgentTurnReviewTab(path: string): AgentTurnReviewTab | undefined {
    if (!path.startsWith(AGENT_TURN_REVIEW_TAB_PREFIX)) return undefined;
    const segments = path.slice(AGENT_TURN_REVIEW_TAB_PREFIX.length).split('/');
    if (segments.length !== 2) return undefined;
    const [encodedTerminalId, encodedTurnId] = segments;
    if (!encodedTerminalId || !encodedTurnId) return undefined;
    try {
        return {
            terminalId: decodeURIComponent(encodedTerminalId),
            turnId: decodeURIComponent(encodedTurnId),
        };
    } catch {
        return undefined;
    }
}

export function isAgentTurnReviewTabPath(path: string): boolean {
    return Boolean(parseAgentTurnReviewTab(path));
}
