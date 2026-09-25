import type { TerminalHostScope } from '../../terminal-host/protocol';
import type {
    RemoteTerminalIdentity,
    TerminalHostCapability,
    TerminalHostEvent,
} from './execution-contract';

/**
 * The identity a Host event belongs to, or nothing when the event predates the Terminal's current PTY generation or
 * names a Session the Terminal no longer belongs to. Every projection starts here so a retired generation cannot
 * surface output, an Agent transition, or an exit against the Terminal that replaced it.
 */
export function currentIdentity(
    identities: ReadonlyMap<string, RemoteTerminalIdentity>,
    event: TerminalHostEvent,
): RemoteTerminalIdentity | undefined {
    const identity = identities.get(event.identity.terminalId);
    if (
        !identity ||
        identity.record.sessionId !== event.identity.sessionId ||
        identity.generation !== event.identity.ptyGeneration
    )
        return;
    return identity;
}

export function terminalScope(
    identity: RemoteTerminalIdentity,
    capability: TerminalHostCapability,
    attachmentId?: string,
): Extract<TerminalHostScope, { scope: 'terminal' }> {
    return {
        scope: 'terminal',
        capability,
        sessionId: identity.record.sessionId,
        terminalId: identity.record.id,
        ptyGeneration: identity.generation,
        ...(attachmentId && { attachmentId }),
    };
}
