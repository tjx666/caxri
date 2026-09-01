import type { TerminalHostScope } from '../../terminal-host/protocol';
import type { RemoteTerminalIdentity, TerminalHostCapability } from './execution-contract';

export function terminalScope(
    identity: RemoteTerminalIdentity,
    capability: TerminalHostCapability,
    attachmentId?: string,
): TerminalHostScope {
    return {
        scope: 'terminal',
        capability,
        sessionId: identity.record.sessionId,
        terminalId: identity.record.id,
        ptyGeneration: identity.generation,
        ...(attachmentId && { attachmentId }),
    };
}
