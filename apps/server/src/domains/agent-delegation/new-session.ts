import type {
    AgentDelegationCreate,
    AgentDelegationCreateRequest,
    AgentDelegationReceipt,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { DelegationAuthority } from './admission';
import { isAgentCommanderCaller } from './admission';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * Resolves the Session a create request runs in, then admits it. `newSession` is the Agent Commander's shortcut: the
 * Session is created here, right before its Agent Terminal, so the Workbench never shows it empty while the Commander
 * composes a second command. A retry of the same request reuses the Session its first attempt created, and a request
 * refused before any task was recorded removes the empty Session again (metadata only; the Project folder is never
 * touched).
 */
export async function admitDelegationRequest(
    options: Pick<AgentDelegationServiceOptions, 'commanderSessions' | 'database'>,
    id: string,
    authority: DelegationAuthority,
    request: AgentDelegationCreateRequest,
    admit: (input: AgentDelegationCreate) => Promise<AgentDelegationReceipt>,
): Promise<AgentDelegationReceipt> {
    const { newSession, sessionId: requestedSessionId, ...fields } = request;
    if (!newSession) return admit({ ...fields, sessionId: requestedSessionId! });
    const { commanderSessions, database } = options;
    const existing = database.agentDelegations.get(id);
    if (existing) return admit({ ...fields, sessionId: existing.input.sessionId });
    if (!commanderSessions || !isAgentCommanderCaller(database, authority))
        throw new CaxriError(
            'FORBIDDEN',
            'Only the Agent Commander can delegate into a new Session',
        );
    const sessionId = commanderSessions.create(fields.projectId);
    try {
        return await admit({ ...fields, sessionId });
    } catch (error) {
        const recorded = database.agentDelegations.get(id);
        if (recorded?.input.sessionId === sessionId) throw error;
        commanderSessions.discard(sessionId);
        /**
         * A concurrent retry of the same request created its own Session before admission recorded the task in the
         * other one, and was refused as a different request. Its Session stays empty, so it is removed and the retry
         * resolves to the recorded task like any later retry.
         */
        if (!recorded) throw error;
        return admit({ ...fields, sessionId: recorded.input.sessionId });
    }
}
