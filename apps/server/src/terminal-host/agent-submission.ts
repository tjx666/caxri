import type { TerminalExecutionOwner } from './runtime';

interface SubmissionIdentity {
    agentLaunchId?: string;
    agentProcessId?: number;
    running: boolean;
}

/**
 * Waits for both PTY writes to complete. A queued or partially written paste is ambiguous after Agent exit; the
 * launcher's exit handshake discards any remainder before the parent shell can resume.
 */
export async function submitAgentText(
    engine: Pick<TerminalExecutionOwner, 'writeWithCompletion'>,
    identity: SubmissionIdentity | undefined,
    terminalId: string,
    launchId: string,
    text: string,
    isAgentRunning: () => boolean,
): Promise<{ outcome: 'accepted' | 'rejected' | 'unknown' }> {
    if (
        !identity?.running ||
        identity.agentLaunchId !== launchId ||
        identity.agentProcessId === undefined ||
        !isAgentRunning()
    )
        return { outcome: 'rejected' };
    if (!engine.writeWithCompletion) return { outcome: 'rejected' };
    try {
        if (!(await engine.writeWithCompletion(terminalId, `\u{1B}[200~${text}\u{1B}[201~`)))
            return { outcome: 'unknown' };
        if (!isAgentRunning()) return { outcome: 'unknown' };
        return {
            outcome: (await engine.writeWithCompletion(terminalId, '\r')) ? 'accepted' : 'unknown',
        };
    } catch {
        return { outcome: 'unknown' };
    }
}
