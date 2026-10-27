import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { hasSessionActivityChanged } from '../session-activity-log';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.length = 0;
});

describe('hasSessionActivityChanged', () => {
    it('logs each activity or attention transition with its source and skips silent writes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-activity-log-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const terminalId = created.terminal!.id;
        const write = vi.fn<(level: string, event: string, options: unknown) => void>();
        const logger = { write };
        const lifecycle = (phase: 'turnStarted' | 'turnFinished') =>
            hasSessionActivityChanged(database, logger, {
                applyWrite: () =>
                    database.updateAgentLifecycle({
                        launchId: 'launch-1',
                        phase,
                        provider: 'claude',
                        terminalId,
                    }),
                phase,
                source: phase === 'turnFinished' ? 'deferredHook' : 'hook',
                terminalId,
            });

        try {
            expect(lifecycle('turnStarted')).toBe(true);
            expect(write).toHaveBeenLastCalledWith('info', 'agent.session_activity_changed', {
                fields: {
                    attentionGeneration: 0,
                    attentionKind: null,
                    from: 'idle',
                    phase: 'turnStarted',
                    provider: 'claude',
                    acknowledgedAttentionGeneration: 0,
                    sessionId: created.session.id,
                    source: 'hook',
                    terminalId,
                    to: 'running',
                },
            });

            // A repeated signal changes nothing durable and must not be logged as a transition.
            expect(lifecycle('turnStarted')).toBe(false);
            expect(write).toHaveBeenCalledTimes(1);

            expect(lifecycle('turnFinished')).toBe(true);
            expect(write).toHaveBeenCalledTimes(2);
            expect(write.mock.lastCall?.[2]).toMatchObject({
                fields: {
                    attentionGeneration: 1,
                    attentionKind: 'completed',
                    from: 'running',
                    source: 'deferredHook',
                    to: 'completed',
                },
            });

            // A self-started turn supersedes the unread finish; the read acknowledgement is part of the transition.
            expect(lifecycle('turnStarted')).toBe(true);
            expect(write).toHaveBeenCalledTimes(3);
            expect(write.mock.lastCall?.[2]).toMatchObject({
                fields: {
                    attentionGeneration: 1,
                    from: 'completed',
                    acknowledgedAttentionGeneration: 1,
                    to: 'running',
                },
            });

            // A write that changed unrelated fields only is reported as changed without a transition log.
            expect(
                hasSessionActivityChanged(database, logger, {
                    applyWrite: () => true,
                    source: 'probe',
                    terminalId,
                }),
            ).toBe(true);
            expect(write).toHaveBeenCalledTimes(3);
        } finally {
            database.close();
        }
    });
});
