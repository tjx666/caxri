import type {
    AgentDelegationCreate,
    AgentDelegationCreateRequest,
    AgentDelegationReceipt,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { DelegationAuthority } from './admission';
import { isCaxriBotCaller } from './admission';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * Resolves the Session a create request runs in, then admits it. `newSession` creates the Session here, right before
 * its Agent Terminal, so the Workbench never shows it empty while the caller composes a second command. Any Agent or
 * the owner (from the CLI or a Client) may use it; an external delegation identity stays bound to its one Session. A
 * retry of the same request reuses the Session its first attempt created, and a request refused before any task was
 * recorded removes the empty Session again (metadata only; the Project folder is never touched). The Session carries
 * the caller's title from the start; see `agentDelegationCreateRequestSchema`.
 */
export async function admitDelegationRequest(
    options: Pick<AgentDelegationServiceOptions, 'newSessions' | 'database'>,
    id: string,
    authority: DelegationAuthority,
    request: AgentDelegationCreateRequest,
    admit: (input: AgentDelegationCreate, isNewSession: boolean) => Promise<AgentDelegationReceipt>,
): Promise<AgentDelegationReceipt> {
    const { newSession, sessionId: requestedSessionId, title, worktreeBranch, ...fields } = request;
    if (!newSession) return admit({ ...fields, sessionId: requestedSessionId! }, false);
    const { newSessions, database } = options;
    const existing = database.agentDelegations.get(id);
    if (existing) return admit({ ...fields, sessionId: existing.input.sessionId }, false);
    const { kind } = authority.principal;
    if (!newSessions || (kind !== 'agent' && kind !== 'human-cli' && kind !== 'desktop'))
        throw new CaxriError('FORBIDDEN', 'This caller cannot delegate into a new Session');
    const isBot = isCaxriBotCaller(database, authority);
    if (worktreeBranch && (isBot || !newSessions.prepareWorktree))
        throw new CaxriError('FORBIDDEN', 'This caller cannot delegate into a new worktree');
    /**
     * An Agent's own Session, or the Chat a Client continues in another Agent (`agentChat.continueInAgent`).
     */
    const callerSessionId =
        (kind === 'agent' || kind === 'desktop') && authority.callerTerminalId
            ? database.getTerminal(authority.callerTerminalId)?.sessionId
            : undefined;
    /**
     * The worktree comes first: when Git refuses it, no Session was created and none needs removing.
     */
    const worktree = worktreeBranch
        ? await newSessions.prepareWorktree!(fields.projectId, worktreeBranch)
        : undefined;
    const sessionId = newSessions.create(
        fields.projectId,
        title,
        isBot,
        isBot ? undefined : callerSessionId,
        worktree,
    );
    try {
        return await admit({ ...fields, sessionId }, true);
    } catch (error) {
        const recorded = database.agentDelegations.get(id);
        if (recorded?.input.sessionId === sessionId) throw error;
        newSessions.discard(sessionId);
        /**
         * A concurrent retry of the same request created its own Session before admission recorded the task in the
         * other one, and was refused as a different request. Its Session stays empty, so it is removed and the retry
         * resolves to the recorded task like any later retry.
         */
        if (!recorded) throw error;
        return admit({ ...fields, sessionId: recorded.input.sessionId }, false);
    }
}
