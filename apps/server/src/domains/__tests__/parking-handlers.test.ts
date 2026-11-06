import { describe, expect, it, vi } from 'vitest';

import type { SessionParkingOptions } from '../parking-handlers';
import { createSessionHandlers, createTerminateAllHandler } from '../parking-handlers';

describe('terminal.terminateAll', () => {
    it('closes Chats only after every launch in flight settled, including one that started a Chat meanwhile', async () => {
        const terminals = [{ sessionId: 'session-1' }];
        const terminated = Promise.withResolvers<string[]>();
        const closeSession = vi.fn<(sessionId: string) => Promise<void>>(() => Promise.resolve());
        const handlers = createTerminateAllHandler({
            agentChat: { closeSession },
            botRestores: { cancelAll: vi.fn() },
            database: { listTerminals: () => terminals },
            terminalRestores: { cancelAll: vi.fn() },
            terminalSuspension: { terminateAll: () => terminated.promise },
        } as unknown as SessionParkingOptions);

        const terminating = (handlers['terminal.terminateAll'] as () => Promise<null>)();
        // A restart or a switch to Chat that was in flight lands while `terminateAll` waits for it.
        terminals.push({ sessionId: 'session-2' });
        await Promise.resolve();
        expect(closeSession).not.toHaveBeenCalled();
        terminated.resolve([]);
        await terminating;

        expect(closeSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
            'session-1',
            'session-2',
        ]);
    });
});

describe('session.archive racing session.unarchive', () => {
    function setup() {
        const session = { archivedAt: undefined as number | undefined };
        const suspended = Promise.withResolvers<void>();
        const settled = Promise.withResolvers<void>();
        const suspendSession = vi.fn(() => suspended.promise);
        const closeSession = vi.fn(() => Promise.resolve());
        const schedule = vi.fn();
        const evictSessions = vi.fn();
        const database = {
            archiveSession: () => {
                session.archivedAt = 1;
                return session;
            },
            getSession: () => session,
            unarchiveSessions: () => {
                session.archivedAt = undefined;
                return [session];
            },
        };
        const handlers = createSessionHandlers(
            database as never,
            {
                database,
                archivedWorktrees: {
                    prepare: () => Promise.resolve({ folder: 'x' }),
                    schedule,
                    withdraw: vi.fn(),
                },
                agentChat: { closeSession },
                mobileTerminalMutations: {
                    runSessions: (_ids: string[], task: () => unknown) => task(),
                },
                terminalRestores: { cancel: vi.fn(), settled: () => settled.promise },
                terminalSuspension: { suspendSession },
                evictSessions,
                restoreSelection: vi.fn(),
                sendFullStateChange: vi.fn(),
            } as never,
            {} as never,
        );
        return {
            closeSession,
            evictSessions,
            handlers,
            schedule,
            settled,
            suspendSession,
            suspended,
        };
    }

    it('skips suspension, Chat close, eviction, and worktree removal when unarchived before parking starts', async () => {
        const { closeSession, evictSessions, handlers, schedule, settled, suspendSession } =
            setup();
        const archiving = (handlers['session.archive'] as (input: unknown) => Promise<unknown>)({
            sessionId: 's1',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        (handlers['session.unarchive'] as (input: unknown) => unknown)({
            sessionId: 's1',
            placement: 'top',
        });
        settled.resolve();
        await archiving;
        expect(suspendSession).not.toHaveBeenCalled();
        expect(closeSession).not.toHaveBeenCalled();
        expect(evictSessions).toHaveBeenCalledWith([]);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('keeps the Chat open and the worktree when unarchived while suspension is pending', async () => {
        const { closeSession, handlers, schedule, settled, suspendSession, suspended } = setup();
        const archiving = (handlers['session.archive'] as (input: unknown) => Promise<unknown>)({
            sessionId: 's1',
        });
        settled.resolve();
        await vi.waitFor(() => expect(suspendSession).toHaveBeenCalled());
        (handlers['session.unarchive'] as (input: unknown) => unknown)({
            sessionId: 's1',
            placement: 'top',
        });
        suspended.resolve();
        await archiving;
        expect(closeSession).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
    });

    it('still closes the Chat and schedules removal when nothing unarchives', async () => {
        const { closeSession, handlers, schedule, settled, suspended } = setup();
        const archiving = (handlers['session.archive'] as (input: unknown) => Promise<unknown>)({
            sessionId: 's1',
        });
        settled.resolve();
        suspended.resolve();
        await archiving;
        expect(closeSession).toHaveBeenCalledWith('s1');
        expect(schedule).toHaveBeenCalled();
    });
});
