import type { ServerOperationRequest } from '@caxri/protocol';

import type { AgentEndpointRegistry } from './registry';

/**
 * Retires managed identities before a domain mutation can remove or restart their owner.
 */
export function retireEndpointsForOperation(
    registry: AgentEndpointRegistry,
    request: ServerOperationRequest,
): void {
    switch (request.method) {
        case 'terminal.close':
            registry.forgetTerminal(request.params.terminalId);
            break;
        // Restart preserves the Terminal's monotonic generation record for the next begin().
        case 'terminal.restart':
        case 'terminal.switchSurface':
            registry.retireTerminal(request.params.terminalId);
            break;
        case 'session.delete':
            registry.forgetSession(request.params.sessionId);
            break;
        case 'session.deleteMany':
            for (const sessionId of request.params.sessionIds) registry.forgetSession(sessionId);
            break;
        case 'project.delete':
            registry.forgetProject(request.params.projectId);
            break;
        case 'terminal.terminateAll':
            registry.clear();
            break;
        default:
            break;
    }
}
