import type { Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError, MOBILE_AGENT_ACTIONS_MAX, searchAgentActions } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';

/**
 * Authorizes a Terminal for a paired device by exact id. The introspection `selector` falls back to title matching, and
 * callers forward the raw `terminalId` to Desktop, so a visible Terminal titled with an unauthorized Terminal's id
 * would pass the check while Desktop acts on the other one. The mobile protocol only carries ids, so any non-exact
 * match is `NOT_FOUND`.
 */
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
    if (terminal?.id !== terminalId) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    return terminal;
};

/**
 * Reads only the active Agent endpoint's actions after checking the terminal's authorized Session. A `query` ranks the
 * whole list with the Desktop picker's search before the reply keeps its bounded top slice, so a skill beyond the first
 * {@link MOBILE_AGENT_ACTIONS_MAX} is still found once the user types part of its name.
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
    const query = request.params.query;
    const ranked = query === undefined ? result.actions : searchAgentActions(result.actions, query);
    return {
        actions: ranked.slice(0, MOBILE_AGENT_ACTIONS_MAX),
        truncated: result.discovery === 'partial' || ranked.length > MOBILE_AGENT_ACTIONS_MAX,
    };
}

/**
 * Reopens a granted Agent Terminal on the other surface through Desktop's own `terminal.switchSurface`, which owns the
 * Chat-capability check and the running-turn guard. The grant check comes first, so a Terminal outside the device's
 * Projects is `NOT_FOUND` before anything is relaunched. The access controller admits it like Session management: only
 * admission waits in the authority queue, since the provider restart takes seconds and may outlive a revoke, which then
 * withholds the result.
 */
export async function switchMobileTerminalSurface(
    domainService: ServerDomainService,
    principal: Principal,
    request: Extract<ServerRequest, { method: 'mobile.terminal.switchSurface' }>,
    signal: AbortSignal,
): Promise<{ status: 'switched' | 'turnRunning' }> {
    const { interruptTurn, surface, terminalId } = request.params;
    await terminalForPrincipal(domainService, principal, terminalId);
    const result = await domainService.requestWithSignal(
        'terminal.switchSurface',
        { terminalId, surface, interruptTurn },
        signal,
    );
    return { status: result.status };
}
