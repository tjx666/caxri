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
        database.selectSession(first.id);
        database.renameSession(first.id, 'Renamed without activity');
        database.archiveSession(first.id);
        database.unarchiveSession(first.id);
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
        database.deleteSession(third.id);
        expect(database.getAppState('lastSelectedSessionId')).toBe(second.id);

        const fourth = database.createSession(project.id, 'shell').session;
        database.touchSessionActivity(first.id, 'user_submission');
        database.archiveSession(fourth.id);
        expect(database.getAppState('lastSelectedSessionId')).toBe(first.id);

        const otherProject = database.createProject(join(directory, 'other'));
        database.createSession(otherProject.id, 'shell');
        database.touchSessionActivity(second.id, 'user_submission');
        database.deleteProject(otherProject.id);
        expect(database.getAppState('lastSelectedSessionId')).toBe(second.id);
        database.close();
    });
});
