import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { QuitRestoreOptions } from '../quit-restore';
import { QuitRestore } from '../quit-restore';

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
    const resumed: Array<{ sessionId: string; terminalIds: string[]; shouldContinue: boolean }> =
        [];
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
        resume: (sessionId, terminalIds, shouldContinue) => {
            if (fixture.failing?.includes(sessionId))
                return Promise.reject(new Error('spawn failed'));
            resumed.push({ sessionId, terminalIds: [...terminalIds], shouldContinue });
            return Promise.resolve();
        },
        logger: { write } as unknown as StructuredLogger,
        now: () => 1_000,
    });
    return { archived, restore, resumed, sessions, stored, write };
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
            { sessionId: 's1', terminalIds: ['t-s1'], shouldContinue: false },
            { sessionId: 's2', terminalIds: ['t-s2'], shouldContinue: true },
            { sessionId: 's3', terminalIds: [], shouldContinue: false },
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
});
