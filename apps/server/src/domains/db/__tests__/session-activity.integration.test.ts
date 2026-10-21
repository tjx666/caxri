import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.length = 0;
});

describe('Session Activity persistence', () => {
    it('tracks a live primary Agent process without fabricating Session activity', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-agent-process-state-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');

        database.updateTerminalState(created.terminal!.id, 'running');

        expect(database.getTerminal(created.terminal!.id)?.lastProcessState).toBe('running');
        expect(database.getSession(created.session.id)).toMatchObject({
            lastActivityState: 'idle',
            lastSessionActivityReason: 'created',
        });
        database.close();
    });

    it('stays independent from visits and uses globally monotonic timestamps', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-session-activity-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const first = database.createSession(project.id, 'shell').session;
        const second = database.createSession(project.id, 'shell').session;

        expect(first).toMatchObject({
            lastSessionActivityAt: first.createdAt,
            lastSessionActivityReason: 'created',
        });
        expect(second.lastSessionActivityAt).toBeGreaterThan(first.lastSessionActivityAt);
        database.selectSession(first.id, 'main');
        database.renameSession(first.id, 'Renamed without activity');
        database.archiveSession(first.id);
        database.unarchiveSessions([first.id]);
        database.updateSessionState(database.getSessionState(first.id));
        expect(database.getSession(first.id)).toMatchObject({
            lastSessionActivityAt: first.createdAt,
            lastSessionActivityReason: 'created',
        });

        database.touchSessionActivity(first.id, 'user_submission', 1);
        const firstTouched = database.getSession(first.id)!;
        database.touchSessionActivity(second.id, 'agent_waiting', 1);
        const secondTouched = database.getSession(second.id)!;

        expect(firstTouched.lastSessionActivityAt).toBeGreaterThan(second.lastSessionActivityAt);
        expect(firstTouched.lastSessionActivityReason).toBe('user_submission');
        expect(secondTouched.lastSessionActivityAt).toBeGreaterThan(
            firstTouched.lastSessionActivityAt,
        );
        expect(secondTouched.lastSessionActivityReason).toBe('agent_waiting');

        const agent = database.createSession(project.id, 'codex');
        // A probed turn-end state is only trusted once the Session was observed running (see
        // `metadataActivityState` in session-policy.ts), so record a turn before the wait.
        database.updateAgentMetadata(
            agent.terminal!.id,
            { provider: 'codex', available: true, observedAt: Date.now(), status: 'running' },
            true,
        );
        database.updateAgentMetadata(
            agent.terminal!.id,
            {
                provider: 'codex',
                attentionKind: 'waiting',
                available: true,
                observedAt: Date.now(),
                status: 'waiting',
            },
            true,
        );
        const unread = database.getSession(agent.session.id)!;
        expect(
            database.markSessionAttentionRead(agent.session.id, unread.attentionEpoch),
        ).toMatchObject({ acknowledged: true });
        expect(database.getSession(agent.session.id)?.lastSessionActivityAt).toBe(
            unread.lastSessionActivityAt,
        );
        database.close();
    });

    it('uses visible activity order for Session and Project fallback selection', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-activity-fallback-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const first = database.createSession(project.id, 'shell').session;
        const second = database.createSession(project.id, 'shell').session;
        const third = database.createSession(project.id, 'shell').session;

        database.touchSessionActivity(second.id, 'user_submission');
        database.selectSession(third.id, 'main');
        database.deleteSession(third.id);
        expect(database.windowOpenSessions.get('main').activeSessionId).toBe(second.id);

        // Preview entries only replace each other, so empty the strip to test the fallback alone.
        database.windowOpenSessions.set('main', []);
        const fourth = database.createSession(project.id, 'shell').session;
        database.touchSessionActivity(first.id, 'user_submission');
        database.selectSession(fourth.id, 'main');
        database.archiveSession(fourth.id);
        expect(database.windowOpenSessions.get('main').activeSessionId).toBe(first.id);

        database.windowOpenSessions.set('main', []);
        const otherProject = database.createProject(join(directory, 'other'));
        database.selectSession(database.createSession(otherProject.id, 'shell').session.id, 'main');
        database.touchSessionActivity(second.id, 'user_submission');
        database.deleteProject(otherProject.id);
        expect(database.windowOpenSessions.get('main').activeSessionId).toBe(second.id);
        database.close();
    });

    it('atomically consumes one reply for an exact waiting attention generation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-attention-reply-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        /**
         * A probe only proves a turn ended for a Session it already observed `running`, so the waiting generation under
         * test has to follow a real running turn.
         */
        database.updateAgentMetadata(
            created.terminal!.id,
            {
                provider: 'codex',
                available: true,
                observedAt: Date.now(),
                status: 'running',
            },
            true,
        );
        database.updateAgentMetadata(
            created.terminal!.id,
            {
                provider: 'codex',
                attentionKind: 'waiting',
                available: true,
                observedAt: Date.now(),
                status: 'waiting',
            },
            true,
        );
        const waiting = database.getSession(created.session.id)!;
        expect(
            database.consumeSessionAttentionReply(
                waiting.id,
                created.terminal!.id,
                waiting.attentionEpoch,
            ),
        ).toBe(true);
        expect(
            database.consumeSessionAttentionReply(
                waiting.id,
                created.terminal!.id,
                waiting.attentionEpoch,
            ),
        ).toBe(false);
        expect(database.getSession(waiting.id)?.lastActivityState).toBe('running');
        expect(database.getSession(waiting.id)).toMatchObject({
            lastSessionActivityAt: waiting.lastSessionActivityAt,
            lastSessionActivityReason: waiting.lastSessionActivityReason,
            sidebarOrder: waiting.sidebarOrder,
        });
        expect(
            database.releaseSessionAttentionReply(
                waiting.id,
                created.terminal!.id,
                waiting.attentionEpoch,
                waiting.lastSessionActivityAt,
            ),
        ).toBe(true);
        expect(database.getSession(waiting.id)).toMatchObject({
            lastActivityState: 'waiting',
            lastSessionActivityAt: waiting.lastSessionActivityAt,
            sidebarOrder: waiting.sidebarOrder,
        });
        expect(
            database.consumeSessionAttentionReply(
                waiting.id,
                created.terminal!.id,
                waiting.attentionEpoch,
            ),
        ).toBe(true);
        database.touchSessionActivity(waiting.id, 'agent_started');
        expect(
            database.releaseSessionAttentionReply(
                waiting.id,
                created.terminal!.id,
                waiting.attentionEpoch,
                waiting.lastSessionActivityAt,
            ),
        ).toBe(false);
        expect(database.getSession(waiting.id)?.lastActivityState).toBe('running');
        database.close();
    });
});
