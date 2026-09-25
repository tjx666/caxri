import type { AgentOutputRecoverySettings, TerminalRecord } from '@caxri/protocol';

import type { RemoteTerminalIdentity, TerminalHostControl } from './execution-contract';
import { terminalScope } from './execution-scope';

export function configureHostOutputRecovery(
    supervisor: TerminalHostControl,
    identities: ReadonlyMap<string, RemoteTerminalIdentity>,
    terminalId: string,
    provider: TerminalRecord['provider'],
    settings: AgentOutputRecoverySettings | undefined,
    background: (request: Promise<unknown>, method: string, terminalId: string) => void,
): void {
    const identity = identities.get(terminalId);
    if (!identity) return;
    identity.record = { ...identity.record, provider };
    background(
        supervisor.request(
            {
                method: 'terminal.recovery.configure',
                params: { provider, ...(settings && { settings }) },
            },
            terminalScope(identity, 'terminal.lifecycle'),
        ),
        'terminal.recovery.configure',
        terminalId,
    );
}

export function canSignalHostProcessExact(
    supervisor: TerminalHostControl,
    identities: ReadonlyMap<string, RemoteTerminalIdentity>,
    terminalId: string,
    expectedProcessId: number,
    signal: string,
    background: (request: Promise<unknown>, method: string, terminalId: string) => void,
): boolean {
    const identity = identities.get(terminalId);
    if (identity?.processId !== expectedProcessId || (signal !== 'SIGINT' && signal !== 'SIGHUP'))
        return false;
    background(
        supervisor.request(
            { method: 'terminal.signal', params: { expectedProcessId, signal } },
            terminalScope(identity, 'terminal.lifecycle'),
        ),
        'terminal.signal',
        terminalId,
    );
    return true;
}

export function canSignalHostAgentExact(
    supervisor: TerminalHostControl,
    identities: ReadonlyMap<string, RemoteTerminalIdentity>,
    terminalId: string,
    expectedLaunchId: string,
    signal: string,
    background: (request: Promise<unknown>, method: string, terminalId: string) => void,
): boolean {
    const identity = identities.get(terminalId);
    if (
        identity?.agent?.launchId !== expectedLaunchId ||
        identity.agent.processId === undefined ||
        (signal !== 'SIGINT' && signal !== 'SIGHUP')
    )
        return false;
    background(
        supervisor.request(
            { method: 'terminal.agent.signal', params: { launchId: expectedLaunchId, signal } },
            terminalScope(identity, 'terminal.lifecycle'),
        ),
        'terminal.agent.signal',
        terminalId,
    );
    return true;
}
