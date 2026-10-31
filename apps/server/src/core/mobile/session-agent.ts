import type { MobileSessionMenuState, Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { sessionForPrincipal } from './session-management';

/**
 * The Agent actions of the phone's Session menu, which all change what the Session's Agents run.
 */
export type MobileSessionAgentRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.session.detach'
            | 'mobile.session.handOverToBot'
            | 'mobile.session.reopenConversation'
            | 'mobile.session.restartAgent'
            | 'mobile.session.resume'
            | 'mobile.session.takeBackFromBot';
    }
>;

export const mobileSessionAgentActionMethods: ReadonlySet<string> = new Set<
    MobileSessionAgentRequest['method']
>([
    'mobile.session.detach',
    'mobile.session.handOverToBot',
    'mobile.session.reopenConversation',
    'mobile.session.restartAgent',
    'mobile.session.resume',
    'mobile.session.takeBackFromBot',
]);

/**
 * What the phone's Session menu reads when it opens, after the grant check: whether Caxri Bot manages the Session, and
 * the Agent conversations the Session can bring back, as Desktop's Session row menu reads them. The phone never learns
 * an Agent's conversation id, so whether Restart Agent has a conversation to resume is answered from the same history:
 * the primary Agent Terminal still holds one of the Session's conversations.
 */
export const readMobileSessionMenuState = async (
    domainService: ServerDomainService,
    principal: Principal,
    sessionId: string,
): Promise<MobileSessionMenuState> => {
    const session = await sessionForPrincipal(domainService, principal, sessionId);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the grant check must pass before the Session's state is read.
    const [managed, history] = await Promise.all([
        domainService.request('bot.managedSessions', {}),
        domainService.request('session.agentHistory', { sessionId }),
    ]);
    const primaryTerminalId = session.primaryAgentTerminalId;
    return {
        isBotManaged: managed.sessionIds.includes(sessionId),
        hasConversation:
            primaryTerminalId !== undefined &&
            history.entries.some((entry) => entry.terminalId === primaryTerminalId),
        conversations: history.entries
            .filter((entry) => entry.terminalId === undefined)
            .map(({ agentSessionId, boundAt, provider, title }) => ({
                agentSessionId,
                boundAt,
                provider,
                ...(title !== undefined && { title }),
            })),
    };
};

/**
 * Runs one Agent action on a granted Session through Desktop's own handler, so the phone and the Session row menu keep
 * one implementation. The phone asks before Restart and Detach end a running turn, so neither asks here.
 */
export const applyMobileSessionAgentAction = async (
    domainService: ServerDomainService,
    principal: Principal,
    request: MobileSessionAgentRequest,
    signal: AbortSignal,
) => {
    const { sessionId } = request.params;
    const session = await sessionForPrincipal(domainService, principal, sessionId);
    switch (request.method) {
        case 'mobile.session.restartAgent': {
            /**
             * Desktop's menu restarts the primary Agent only, never every Agent of the Session the way Detach does.
             */
            const terminalId = session.primaryAgentTerminalId;
            if (!terminalId) throw new CaxriError('CONFLICT', 'This Session has no Agent');
            await domainService.requestWithSignal(
                'terminal.restart',
                { terminalId, mode: 'resume' },
                signal,
            );
            return { sessionId };
        }
        case 'mobile.session.detach': {
            await domainService.requestWithSignal('session.detach', { sessionId }, signal);
            return { sessionId };
        }
        case 'mobile.session.resume': {
            // No `windowKey`: resuming from the phone must not change which Session the computer shows.
            await domainService.requestWithSignal('session.resume', { sessionId }, signal);
            return { sessionId };
        }
        case 'mobile.session.reopenConversation': {
            const { terminalId } = await domainService.requestWithSignal(
                'session.reopenConversation',
                request.params,
                signal,
            );
            return { sessionId, terminalId };
        }
        case 'mobile.session.handOverToBot': {
            // Desktop's Workbench sets Caxri Bot up first when the user never opened it; the phone has no other way to.
            await domainService.requestWithSignal('bot.ensure', {}, signal);
            const { outcomes } = await domainService.requestWithSignal(
                'bot.session.handOver',
                { sessionIds: [sessionId], conversations: [] },
                signal,
            );
            const outcome = outcomes.at(0);
            if (outcome?.outcome === 'accepted') return { outcome: 'accepted' as const, sessionId };
            return {
                outcome: 'rejected' as const,
                reason: outcome?.reason ?? ('session_missing' as const),
            };
        }
        case 'mobile.session.takeBackFromBot': {
            await domainService.requestWithSignal('bot.session.takeBack', { sessionId }, signal);
            return { sessionId };
        }
    }
};
