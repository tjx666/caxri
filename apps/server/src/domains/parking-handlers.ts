import type { FullStateChangeReason, Principal, SessionRestorePlacement } from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import type { AgentChatService } from './agent-chat';
import { isCaxriBotCaller } from './agent-delegation';
import { requireBotSession } from './bot';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { MobileTerminalMutationQueue } from './mobile';
import type { SessionRenameService } from './session';
import type { TerminalRestoreSupervisor, TerminalSuspensionService } from './terminal';

export interface SessionParkingOptions {
    database: CaxriDatabase;
    agentChat: Pick<AgentChatService, 'closeSession'>;
    botRestores: Pick<TerminalRestoreSupervisor, 'cancelAll'>;
    mobileTerminalMutations: Pick<MobileTerminalMutationQueue, 'runProject' | 'runSessions'>;
    terminalRestores: Pick<TerminalRestoreSupervisor, 'cancel' | 'cancelAll' | 'settled'>;
    terminalSuspension: Pick<
        TerminalSuspensionService,
        'detachSession' | 'suspendSession' | 'terminateAll'
    >;
    evictSessions(sessionIds: readonly string[]): void;
    restoreSelection(): void;
    sendFullStateChange(reason: FullStateChangeReason): void;
}

/**
 * The runtime half of taking Sessions out of the Workbench, shared by `session.archive` and `project.hide` so neither
 * can leave a process behind that the other stops. The caller holds the Sessions' mutation lock and has already written
 * the durable mark. `cancel` fences only restores that have not reached PTY spawn, so the rest are awaited before
 * suspension looks for processes; a Host start still in flight after that is parked by
 * `TerminalSuspensionService.parkLaunch` once it lands. Live PTYs are suspended (they resume on selection) and live
 * Chats stopped, which is what the close prompt and Server Core's idle exit count.
 */
export async function parkSessions(
    options: SessionParkingOptions,
    sessionIds: readonly string[],
    reason: 'project.hide' | 'session.archive',
): Promise<void> {
    for (const sessionId of sessionIds) options.terminalRestores.cancel(sessionId);
    await Promise.all(
        sessionIds.map(async (sessionId) => {
            await options.terminalRestores.settled(sessionId);
            await options.terminalSuspension.suspendSession(sessionId);
            await options.agentChat.closeSession(sessionId);
        }),
    );
    /**
     * A parked Session has no viewer, so its Git trackers, metadata watchers, and snapshots would only hold resources
     * until restart. Unarchiving or adding the root again re-registers them on the next read.
     */
    options.evictSessions(sessionIds);
    options.restoreSelection();
    options.sendFullStateChange(reason);
}

/**
 * Archive and detach park a Session's live Terminals and Chats without deleting anything. An archived Session resumes
 * them when it is selected again; a detached one has handed its Agent Sessions to another client and takes them back
 * only through `session.resume`. Unarchiving returns Sessions to the list; their Terminals resume on selection.
 */
function createSessionParkingHandlers(
    options: SessionParkingOptions,
): Pick<
    DomainHandlers,
    | 'bot.session.archive'
    | 'session.archive'
    | 'session.detach'
    | 'session.unarchive'
    | 'session.unarchiveMany'
> {
    const { agentChat, database, mobileTerminalMutations, terminalRestores, terminalSuspension } =
        options;
    const unarchiveSessions = (
        sessionIds: readonly string[],
        placement: SessionRestorePlacement,
    ) => {
        const restored = database.unarchiveSessions(sessionIds, placement);
        options.sendFullStateChange('session.unarchive');
        return restored;
    };
    const archiveSession = (sessionId: string) =>
        mobileTerminalMutations.runSessions([sessionId], async () => {
            const session = database.archiveSession(sessionId);
            await parkSessions(options, [sessionId], 'session.archive');
            return session;
        });
    return {
        /**
         * The sidebar's archive, admitted only for a Session Caxri Bot created; see `requireBotSession`.
         */
        'bot.session.archive': async ({ sessionId }) => {
            requireBotSession(database, sessionId);
            await archiveSession(sessionId);
            return { sessionId };
        },
        'session.archive': ({ sessionId }) => archiveSession(sessionId),
        'session.detach': ({ sessionId }) =>
            mobileTerminalMutations.runSessions([sessionId], async () => {
                if (!database.getSession(sessionId))
                    throw new CaxriError('NOT_FOUND', 'Session not found');
                /**
                 * A queued restore could relaunch the Agent right after it was handed over; drop it first. One already
                 * past PTY spawn is awaited, as in `parkSessions`, so the detach finds its process. Any other Agent
                 * launch still in flight is handed over by `detachSession` itself.
                 */
                terminalRestores.cancel(sessionId);
                await terminalRestores.settled(sessionId);
                await terminalSuspension.detachSession(sessionId);
                // Durable like a detached PTY: a later read must not resume the conversation another client now holds.
                await agentChat.closeSession(sessionId, 'detached');
                options.sendFullStateChange('session.detach');
                return database.getSession(sessionId)!;
            }),
        'session.unarchive': ({ placement, sessionId }) =>
            unarchiveSessions([sessionId], placement)[0],
        'session.unarchiveMany': ({ placement, sessionIds }) =>
            unarchiveSessions([...new Set(sessionIds)], placement),
    };
}

/**
 * Admits an Agent to manage one Session its own Session created. Everything else is `NOT_FOUND`, the way the Caxri
 * Bot's other Session-scoped requests treat a Session outside their reach, so an Agent cannot probe which Sessions
 * exist.
 *
 * Caxri Bot is held to `requireBotSession`: a Session it created but the user took back, or one the user handed over,
 * is the user's again even though its creator column still names Caxri Bot. That holds for any Terminal in Caxri Bot's
 * Session (a leftover one after Caxri Bot was recreated, say). Any other Agent qualifies through `createdBySessionId`
 * alone, so every Agent in the creating Session shares the right, and a relaunch keeps it. The Project must still be
 * visible: hiding it takes its Sessions out of every Agent's reach.
 */
function authorizeAgentSessionManagement(
    database: CaxriDatabase,
    authority: { principal: Principal; callerTerminalId: string },
    sessionId: string,
): void {
    const caller = database.getTerminal(authority.callerTerminalId);
    if (!caller || authority.principal.kind !== 'agent')
        throw new CaxriError('FORBIDDEN', 'Session management requires an authorized Agent');
    if (
        isCaxriBotCaller(database, authority) ||
        caller.sessionId === database.caxriBotRows()?.sessionId
    ) {
        requireBotSession(database, sessionId);
        return;
    }
    const session = database.getSession(sessionId);
    const project =
        session &&
        database.listVisibleProjects().find((candidate) => candidate.id === session.projectId);
    if (
        !session ||
        !project ||
        session.createdBySessionId !== caller.sessionId ||
        !isTopLevelProject(project)
    )
        throw new CaxriError('NOT_FOUND', 'Session was not created by this Agent');
}

/**
 * The user's Session rename and parking handlers, plus the Agent entry to the same operations. An Agent goes through
 * exactly the code the sidebar runs (provider title synchronization, Terminal parking, Chat shutdown) after admission.
 */
export function createSessionHandlers(
    database: CaxriDatabase,
    parking: SessionParkingOptions,
    renames: Pick<SessionRenameService, 'rename'>,
): ReturnType<typeof createSessionParkingHandlers> &
    Pick<DomainHandlers, 'agent.session.manageInternal' | 'session.rename'> {
    const parkingHandlers = createSessionParkingHandlers(parking);
    return {
        ...parkingHandlers,
        'session.rename': ({ sessionId, displayTitle }, signal, finalizeDurably) =>
            renames.rename(sessionId, displayTitle, signal, finalizeDurably),
        'agent.session.manageInternal': async (
            { operation, sessionId, ...authority },
            signal,
            finalizeDurably,
        ) => {
            authorizeAgentSessionManagement(database, authority, sessionId);
            if (operation.action === 'rename')
                await renames.rename(sessionId, operation.title, signal, finalizeDurably);
            else if (operation.action === 'archive')
                await parkingHandlers['session.archive']({ sessionId });
            else await parkingHandlers['session.unarchive']({ sessionId, placement: 'top' });
            return { sessionId };
        },
    };
}

/**
 * Terminate and Close, and an explicit quit before `host.stop`: stops every running Terminal and Chat as `stopped`
 * while Server Core keeps its services, so a Workbench reopened on the same Server Core can launch, restart, restore,
 * and start Chats again. Queued restores are fenced first so none relaunches a process afterward. Chats close only once
 * `terminateAll` has settled every launch in flight: a Chat restart or a switch to Chat runs inside such a launch, and
 * `closeSession` stops only the Chats that already exist when it runs. A quit's terminal shutdown is the `host.stop`
 * that follows, not this.
 */
export function createTerminateAllHandler(
    options: SessionParkingOptions,
): Pick<DomainHandlers, 'terminal.terminateAll'> {
    const { agentChat, botRestores, database, terminalRestores, terminalSuspension } = options;
    return {
        'terminal.terminateAll': async () => {
            terminalRestores.cancelAll();
            botRestores.cancelAll();
            await terminalSuspension.terminateAll();
            const sessionIds = new Set(database.listTerminals().map(({ sessionId }) => sessionId));
            await Promise.all(
                [...sessionIds].map((sessionId) => agentChat.closeSession(sessionId)),
            );
            return null;
        },
    };
}
