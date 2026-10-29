import type { AgentOutputRecoverySettings, TerminalRecord } from '@caxri/protocol';

import type { RemoteTerminalIdentity, TerminalHostControl } from './execution-contract';
import { terminalScope } from './execution-scope';

/**
 * What the fire-and-forget host actions need from `RemoteTerminalExecution`: the host connection, the live identities,
 * and the owner's observer for a request nobody awaits.
 */
export interface HostActionContext {
    background: (request: Promise<unknown>, method: string, terminalId: string) => void;
    identities: ReadonlyMap<string, RemoteTerminalIdentity>;
    supervisor: TerminalHostControl;
}

export function configureHostOutputRecovery(
    { background, identities, supervisor }: HostActionContext,
    terminalId: string,
    provider: TerminalRecord['provider'],
    settings: AgentOutputRecoverySettings | undefined,
    colors: { background: string; foreground: string } | undefined,
): void {
    const identity = identities.get(terminalId);
    if (!identity) return;
    identity.record = { ...identity.record, provider };
    background(
        supervisor.request(
            {
                method: 'terminal.configure',
                params: { provider, ...(settings && { settings }), ...(colors && { colors }) },
            },
            terminalScope(identity, 'terminal.lifecycle'),
        ),
        'terminal.configure',
        terminalId,
    );
}

export function canSignalHostProcessExact(
    { background, identities, supervisor }: HostActionContext,
    terminalId: string,
    expectedProcessId: number,
    signal: string,
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
    { background, identities, supervisor }: HostActionContext,
    terminalId: string,
    expectedLaunchId: string,
    signal: string,
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
