import type { FullStateChangeReason, SessionRestorePlacement } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentChatService } from './agent-chat';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { MobileTerminalMutationQueue } from './mobile-terminal-mutation-queue';
import type { TerminalRestoreSupervisor, TerminalSuspensionService } from './terminal';

export interface SessionParkingOptions {
    database: CaxriDatabase;
    agentChat: Pick<AgentChatService, 'closeSession'>;
    mobileTerminalMutations: Pick<MobileTerminalMutationQueue, 'runProject' | 'runSessions'>;
    terminalRestores: Pick<TerminalRestoreSupervisor, 'cancel' | 'settled'>;
    terminalSuspension: Pick<TerminalSuspensionService, 'detachSession' | 'suspendSession'>;
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
export function createSessionParkingHandlers(
    options: SessionParkingOptions,
): Pick<
    DomainHandlers,
    'session.archive' | 'session.detach' | 'session.unarchive' | 'session.unarchiveMany'
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
    return {
        'session.archive': ({ sessionId }) =>
            mobileTerminalMutations.runSessions([sessionId], async () => {
                const session = database.archiveSession(sessionId);
                await parkSessions(options, [sessionId], 'session.archive');
                return session;
            }),
        'session.detach': ({ sessionId }) =>
            mobileTerminalMutations.runSessions([sessionId], async () => {
                if (!database.getSession(sessionId))
                    throw new CaxriError('NOT_FOUND', 'Session not found');
                /**
                 * A queued restore could relaunch the Agent right after it was handed over; drop it first. One already
                 * past PTY spawn is awaited, as in `parkSessions`, so the detach finds its process.
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
