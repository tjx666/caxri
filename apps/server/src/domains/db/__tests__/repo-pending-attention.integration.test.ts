import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function claudeSession() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-pending-attention-'));
    temporaryDirectories.push(directory);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const created = database.createSession(database.createProject(directory).id, 'claude');
    const lifecycle = (phase: 'turnFinished' | 'turnStarted') =>
        database.updateAgentLifecycle({
            launchId: 'launch-1',
            phase,
            provider: 'claude',
            terminalId: created.terminal!.id,
        });
    return { database, sessionId: created.session.id, terminalId: created.terminal!.id, lifecycle };
}

/**
 * Pending Attention: a finished turn stays the user's move after it was read, until the user marks it done or the Agent
 * moves on by itself.
 */
describe('CaxriDatabase Pending Attention', () => {
    it('keeps a read result pending until the user marks that exact generation done', async () => {
        const { database, sessionId, lifecycle } = await claudeSession();
        lifecycle('turnStarted');
        lifecycle('turnFinished');
        database.attentionMarks.read(sessionId, 1);
        expect(database.getSession(sessionId)).toMatchObject({
            hasUnread: false,
            hasPendingAttention: true,
        });

        expect(database.attentionMarks.done(sessionId, 0, 5_000).resolved).toBe(false);
        const done = database.attentionMarks.done(sessionId, 1, 5_000);
        expect(done).toMatchObject({
            resolved: true,
            session: {
                hasPendingAttention: false,
                resolvedAttentionGeneration: 1,
                attentionResolvedAt: 5_000,
            },
        });
        // A repeat is a no-op, so a second device's tick cannot move the Session in Idle again.
        expect(database.attentionMarks.done(sessionId, 1, 9_000)).toMatchObject({
            resolved: false,
            session: { attentionResolvedAt: 5_000 },
        });
        database.close();
    });

    it('marks an unread result read when the user marks it done without opening it', async () => {
        const { database, sessionId, lifecycle } = await claudeSession();
        lifecycle('turnStarted');
        lifecycle('turnFinished');
        expect(database.attentionMarks.done(sessionId, 1).session).toMatchObject({
            hasUnread: false,
            hasPendingAttention: false,
            acknowledgedAttentionGeneration: 1,
        });
        database.close();
    });

    it('resolves the pending result when the Agent starts another turn on its own', async () => {
        const { database, sessionId, lifecycle } = await claudeSession();
        lifecycle('turnStarted');
        lifecycle('turnFinished');
        database.attentionMarks.read(sessionId, 1);

        lifecycle('turnStarted');
        const session = database.getSession(sessionId);
        expect(session).toMatchObject({
            hasPendingAttention: false,
            resolvedAttentionGeneration: 1,
            agentActivityState: 'running',
        });
        // The Agent moved on; the user did not tick it, so Idle must not rank it as just resolved.
        expect(session?.attentionResolvedAt).toBeUndefined();
        database.close();
    });

    it('raises failed attention when the Agent process dies, once per failure', async () => {
        const { database, sessionId, terminalId, lifecycle } = await claudeSession();
        lifecycle('turnStarted');
        database.updateTerminalExitState(terminalId, 'dead');
        expect(database.getSession(sessionId)).toMatchObject({
            agentActivityState: 'failed',
            attentionGeneration: 1,
            lastAttentionKind: 'failed',
            hasUnread: true,
            hasPendingAttention: true,
        });

        database.updateTerminalExitState(terminalId, 'dead');
        expect(database.getSession(sessionId)?.attentionGeneration).toBe(1);

        // A failure the user already marked Done stays done when the dead process is reported again.
        database.attentionMarks.done(sessionId, 1);
        database.updateTerminalExitState(terminalId, 'dead');
        expect(database.getSession(sessionId)).toMatchObject({
            attentionGeneration: 1,
            hasPendingAttention: false,
        });
        database.close();
    });

    it('does not raise attention when the Agent process exits cleanly', async () => {
        const { database, sessionId, terminalId, lifecycle } = await claudeSession();
        lifecycle('turnStarted');
        database.updateTerminalExitState(terminalId, 'stopped');
        expect(database.getSession(sessionId)).toMatchObject({
            agentActivityState: 'completed',
            attentionGeneration: 0,
            hasPendingAttention: false,
        });
        database.close();
    });

    it('resolves a batch in one pass, guarding each generation and skipping archived or missing Sessions', async () => {
        const first = await claudeSession();
        first.lifecycle('turnStarted');
        first.lifecycle('turnFinished');
        const { database } = first;
        const projectId = database.getSession(first.sessionId)!.projectId;
        const second = database.createSession(projectId, 'claude');
        const archived = database.createSession(projectId, 'claude');
        for (const created of [second, archived])
            for (const phase of ['turnStarted', 'turnFinished'] as const)
                database.updateAgentLifecycle({
                    launchId: 'launch-1',
                    phase,
                    provider: 'claude',
                    terminalId: created.terminal!.id,
                });
        database.archiveSession(archived.session.id);

        const resolved = database.attentionMarks.doneMany(
            [
                { sessionId: first.sessionId, attentionGeneration: 1 },
                // A newer turn superseded what the Client showed: it stays pending.
                { sessionId: second.session.id, attentionGeneration: 0 },
                { sessionId: archived.session.id, attentionGeneration: 1 },
                { sessionId: 'missing-session', attentionGeneration: 1 },
            ],
            7_000,
        );

        expect(resolved).toEqual([first.sessionId]);
        expect(database.getSession(first.sessionId)).toMatchObject({
            hasPendingAttention: false,
            attentionResolvedAt: 7_000,
        });
        expect(database.getSession(second.session.id)?.hasPendingAttention).toBe(true);
        database.close();
    });

    it('settles automatically without a resolution time, so Idle keeps ranking by real activity', async () => {
        const { database, sessionId, lifecycle } = await claudeSession();
        lifecycle('turnStarted');
        lifecycle('turnFinished');
        expect(database.attentionMarks.settle([{ sessionId, attentionGeneration: 1 }])).toEqual([
            sessionId,
        ]);
        const session = database.getSession(sessionId);
        expect(session?.hasPendingAttention).toBe(false);
        expect(session?.attentionResolvedAt).toBeUndefined();
        database.close();
    });
});
