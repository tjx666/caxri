import type { Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';

export const terminalForPrincipal = async (
    domainService: ServerDomainService,
    principal: Principal,
    terminalId: string,
) => {
    const result = await domainService.request('terminal.queryForPrincipal', {
        principal,
        query: { mode: 'show', selector: terminalId },
    });
    const terminal = result.terminals.at(0);
    if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    return terminal;
};

/**
 * Reads only the active Agent endpoint's actions after checking the terminal's authorized Session.
 */
export async function listMobileAgentActions(
    request: Extract<ServerRequest, { method: 'mobile.agent.actions' }>,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    reauthorize: () => void,
) {
    const terminal = await terminalForPrincipal(
        domainService,
        principal,
        request.params.terminalId,
    );
    if (terminal.sessionId !== request.params.sessionId)
        throw new CaxriError('NOT_FOUND', 'Terminal not found');
    const result = await domainService.request('agentActions.list', {
        terminalId: request.params.terminalId,
    });
    reauthorize();
    return {
        actions: result.actions.slice(0, 40),
        truncated: result.discovery === 'partial' || result.actions.length > 40,
    };
}
