import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { QuitRestoreCause, QuitRestoreOptions } from '../quit-restore';
import { QUIT_RESTORE_AUTO_MAX_AGE_MS, QuitRestore } from '../quit-restore';

interface Fixture {
    archived?: string[];
    bot?: string;
    live?: Record<string, string[]>;
    liveChats?: string[];
    sessions?: string[];
    working?: string[];
    failing?: string[];
    unwritable?: boolean;
}

function createHarness(fixture: Fixture = {}) {
    const sessions = new Set(fixture.sessions ?? ['s1', 's2', 's3']);
    const archived = new Set(fixture.archived);
    const stored = new Map<string, unknown>();
    if (fixture.bot)
        stored.set('caxriBot', {
            projectId: 'bot-project',
            sessionId: fixture.bot,
            sessionIds: [],
        });
    const resumed: Array<{
        sessionId: string;
        terminalIds: string[];
        continueAfter: QuitRestoreCause | undefined;
    }> = [];
    const clock = { now: 1_000 };
    const database = {
        getAppState: (key: string) => stored.get(key),
        setAppState: (key: string, value: unknown) => {
            if (fixture.unwritable) throw new Error('disk full');
            stored.set(key, value);
        },
        getSession: (id: string) =>
            sessions.has(id)
                ? { id, archivedAt: archived.has(id) ? 1 : undefined, projectId: 'p' }
                : id === fixture.bot
                  ? { id, projectId: 'bot-project' }
                  : undefined,
        getProject: (id: string) => ({ id }),
        listTerminals: () =>
            [...sessions, ...(fixture.bot ? [fixture.bot] : [])].map((sessionId) => ({
                id: `t-${sessionId}`,
                sessionId,
            })),
    } as unknown as QuitRestoreOptions['database'];
    const write = vi.fn<StructuredLogger['write']>();
    const restore = new QuitRestore({
        database,
        livePtyIds: (sessionId) => fixture.live?.[sessionId] ?? [],
        hasLiveChat: (sessionId) => fixture.liveChats?.includes(sessionId) ?? false,
        isWorking: (sessionId) => fixture.working?.includes(sessionId) ?? false,
        resume: (sessionId, terminalIds, continueAfter) => {
            if (fixture.failing?.includes(sessionId))
                return Promise.reject(new Error('spawn failed'));
            resumed.push({ sessionId, terminalIds: [...terminalIds], continueAfter });
            return Promise.resolve();
        },
        logger: { write } as unknown as StructuredLogger,
        now: () => clock.now,
    });
    return { archived, clock, restore, resumed, sessions, stored, write };
}

describe('QuitRestore', () => {
    it('restores only the Sessions with live work, continuing the ones that were working', async () => {
        const { restore, resumed } = createHarness({
            live: { s1: ['t-s1'], s2: ['t-s2'] },
            liveChats: ['s3'],
            working: ['s2'],
        });
        restore.record();
        await expect(restore.restore()).resolves.toEqual({ restored: 3, skipped: 0 });
        expect(resumed).toEqual([
            { sessionId: 's1', terminalIds: ['t-s1'], continueAfter: undefined },
            { sessionId: 's2', terminalIds: ['t-s2'], continueAfter: 'quit' },
            { sessionId: 's3', terminalIds: [], continueAfter: undefined },
        ]);
    });

    it('lets the quit stop its tasks when the record cannot be written', () => {
        const { restore, write } = createHarness({ live: { s1: ['t-s1'] }, unwritable: true });
        expect(() => restore.record()).not.toThrow();
        expect(write).toHaveBeenCalledWith('warn', 'session.quit_stopped_record_failed', {
            fields: { errorCode: 'unknown' },
        });
    });

    it('consumes the record, so a second restore relaunches nothing', async () => {
        const { restore, resumed } = createHarness({ live: { s1: ['t-s1'] } });
        restore.record();
        await restore.restore();
        await expect(restore.restore()).resolves.toEqual({ restored: 0, skipped: 0 });
        expect(resumed).toHaveLength(1);
    });

    it('skips Sessions deleted, archived, or failing to relaunch since the quit', async () => {
        const harness = createHarness({
            live: { s1: ['t-s1'], s2: ['t-s2'], s3: ['t-s3'] },
            failing: ['s3'],
        });
        harness.restore.record();
        harness.sessions.delete('s1');
        harness.archived.add('s2');
        await expect(harness.restore.restore()).resolves.toEqual({ restored: 0, skipped: 3 });
    });

    it('keeps the previous record when a later quit stops nothing', async () => {
        const live: Record<string, string[]> = { s1: ['t-s1'] };
        const { restore, resumed } = createHarness({ live });
        restore.record();
        delete live.s1;
        restore.record();
        await expect(restore.restore()).resolves.toEqual({ restored: 1, skipped: 0 });
        expect(resumed.map(({ sessionId }) => sessionId)).toEqual(['s1']);
    });

    it('leaves Caxri Bot to its own restore', async () => {
        const { restore, resumed } = createHarness({
            bot: 'bot',
            live: { s1: ['t-s1'], bot: ['t-bot'] },
        });
        restore.record();
        await restore.restore();
        expect(resumed.map(({ sessionId }) => sessionId)).toEqual(['s1']);
    });

    describe('restoreAfterUpdate', () => {
        it('restores what Restart to Update stopped, telling working Agents the update stopped them', async () => {
            const { restore, resumed } = createHarness({
                live: { s1: ['t-s1'] },
                liveChats: ['s2'],
                working: ['s2'],
            });
            restore.record('update');
            await expect(restore.restoreAfterUpdate()).resolves.toEqual({
                restored: 2,
                skipped: 0,
            });
            expect(resumed).toEqual([
                { sessionId: 's1', terminalIds: ['t-s1'], continueAfter: undefined },
                { sessionId: 's2', terminalIds: [], continueAfter: 'update' },
            ]);
        });

        it('claims the record at once, so the launch notice never offers it', () => {
            const { restore, resumed } = createHarness({ live: { s1: ['t-s1'] } });
            restore.record('update');
            const restoring = restore.restoreAfterUpdate();
            expect(restoring).toBeDefined();
            expect(restore.pending().count).toBe(0);
            // The relaunches wait for the rest of Server Core's start.
            expect(resumed).toHaveLength(0);
            return restoring;
        });

        it('restores only once', async () => {
            const { restore, resumed } = createHarness({ live: { s1: ['t-s1'] } });
            restore.record('update');
            await restore.restoreAfterUpdate();
            expect(restore.restoreAfterUpdate()).toBeUndefined();
            await expect(restore.restore()).resolves.toEqual({ restored: 0, skipped: 0 });
            expect(resumed).toHaveLength(1);
        });

        it('leaves a plain quit to the launch notice', () => {
            const { restore } = createHarness({ live: { s1: ['t-s1'] } });
            restore.record('quit');
            expect(restore.restoreAfterUpdate()).toBeUndefined();
            expect(restore.pending().count).toBe(1);
        });

        it('leaves an update whose relaunch came too late to the launch notice', async () => {
            const { clock, restore, resumed } = createHarness({
                live: { s1: ['t-s1'] },
                working: ['s1'],
            });
            restore.record('update');
            clock.now += QUIT_RESTORE_AUTO_MAX_AGE_MS + 1;
            expect(restore.restoreAfterUpdate()).toBeUndefined();
            expect(restore.pending().count).toBe(1);
            // Restored by hand later, the Agent still learns the update stopped it.
            await restore.restore();
            expect(resumed).toEqual([
                { sessionId: 's1', terminalIds: ['t-s1'], continueAfter: 'update' },
            ]);
        });

        it('hands a Session whose relaunch failed back to the launch notice', async () => {
            const { restore, resumed } = createHarness({
                live: { s1: ['t-s1'], s2: ['t-s2'] },
                failing: ['s2'],
            });
            restore.record('update');
            await expect(restore.restoreAfterUpdate()).resolves.toEqual({
                restored: 1,
                skipped: 1,
            });
            expect(resumed.map(({ sessionId }) => sessionId)).toEqual(['s1']);
            expect(restore.pending().count).toBe(1);
        });

        it("never fails Server Core's start when the record cannot be claimed", () => {
            const { restore, stored, write } = createHarness({ unwritable: true });
            stored.set('quitStoppedSessions', {
                stoppedAt: 1_000,
                restartedForUpdate: true,
                sessions: [{ sessionId: 's1', terminalIds: ['t-s1'], shouldContinue: false }],
            });
            expect(restore.restoreAfterUpdate()).toBeUndefined();
            expect(write).toHaveBeenCalledWith(
                'warn',
                'session.quit_stopped_auto_restore_failed',
                expect.anything(),
            );
            // The record survives for the launch notice.
            expect(restore.pending().count).toBe(1);
        });
    });

    describe('pending', () => {
        it('is zero when no quit stopped anything', () => {
            expect(createHarness().restore.pending().count).toBe(0);
        });

        it('counts what a restore would relaunch without consuming the record', async () => {
            const harness = createHarness({ live: { s1: ['t-s1'], s2: ['t-s2'], s3: ['t-s3'] } });
            harness.restore.record();
            harness.archived.add('s3');
            expect(harness.restore.pending().count).toBe(2);
            expect(harness.restore.pending().stoppedAt).toEqual(expect.any(Number));
            expect(harness.restore.pending().count).toBe(2);
            await expect(harness.restore.restore()).resolves.toEqual({ restored: 2, skipped: 1 });
        });

        it('is zero once the record was consumed', async () => {
            const { restore } = createHarness({ live: { s1: ['t-s1'] } });
            restore.record();
            await restore.restore();
            expect(restore.pending().count).toBe(0);
        });
    });
});
