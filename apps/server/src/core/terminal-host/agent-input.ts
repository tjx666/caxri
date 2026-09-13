import { MAX_TERMINAL_INPUT_LENGTH } from '@caxri/protocol';

import type { RemoteTerminalIdentity, TerminalHostControl } from './execution-contract';
import { terminalScope } from './execution-scope';

/**
 * Sends Core-authorized Agent input without a Renderer attachment, fenced at both the cached launch and Terminal Host.
 */
export async function sendAgentInput(
    supervisor: TerminalHostControl,
    identities: ReadonlyMap<string, RemoteTerminalIdentity>,
    terminalId: string,
    data: string,
): Promise<{ accepted: boolean }> {
    const identity = identities.get(terminalId);
    const agentLaunchId = identity?.agent?.processId ? identity.agent.launchId : undefined;
    if (!agentLaunchId || !identity?.processId) return { accepted: false };
    if (data.length > MAX_TERMINAL_INPUT_LENGTH) return { accepted: false };
    if (data.length === 0) return { accepted: true };
    await identity.ready;
    const current = identities.get(terminalId);
    if (
        current !== identity ||
        current.agent?.launchId !== agentLaunchId ||
        current.agent.processId === undefined ||
        current.processId === undefined
    )
        return { accepted: false };
    const result = (await supervisor.request(
        {
            method: 'terminal.agent.input',
            params: { data, launchId: agentLaunchId },
        },
        terminalScope(identity, 'terminal.agent.input'),
    )) as { accepted: boolean };
    return result;
}
