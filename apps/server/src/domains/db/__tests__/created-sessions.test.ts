import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRelation } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-created-sessions-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(join(directory, 'project'));
    const { session: creator } = database.createSession(project.id, null);
    /**
     * A Session created at a fixed time, so the order does not depend on the clock's resolution.
     */
    const created = (creatorId: string, createdAt: number, createdByRelation?: SessionRelation) => {
        const { session } = database.createSession(project.id, null, undefined, {
            createdBySessionId: creatorId,
            ...(createdByRelation && { createdByRelation }),
        });
        database.database
            .prepare('UPDATE sessions SET created_at = ? WHERE id = ?')
            .run(createdAt, session.id);
        return session.id;
    };
    return { created, creatorId: creator.id, database, projectId: project.id };
}

describe('CreatedSessionsModel.list', () => {
    it('lists the related Sessions of the named creating Sessions, newest first', async () => {
        const { created, creatorId, database } = await fixture();
        const old = created(creatorId, 10, 'delegated');
        const recent = created(creatorId, 30, 'consult');
        const middle = created(creatorId, 20, 'handoff');

        expect(database.createdSessions.list([creatorId], 10)).toEqual([
            {
                sessionId: recent,
                createdBySessionId: creatorId,
                relation: 'consult',
                createdAt: 30,
            },
            {
                sessionId: middle,
                createdBySessionId: creatorId,
                relation: 'handoff',
                createdAt: 20,
            },
            { sessionId: old, createdBySessionId: creatorId, relation: 'delegated', createdAt: 10 },
        ]);
    });

    it('stops at the limit, keeping the newest', async () => {
        const { created, creatorId, database } = await fixture();
        created(creatorId, 10, 'delegated');
        const newest = created(creatorId, 20, 'delegated');

        expect(
            database.createdSessions.list([creatorId], 1).map(({ sessionId }) => sessionId),
        ).toEqual([newest]);
    });

    it('ignores a Session created without a relation and a Session another Session created', async () => {
        const { created, creatorId, database, projectId } = await fixture();
        const { session: other } = database.createSession(projectId, null);
        const related = created(creatorId, 10, 'delegated');
        created(creatorId, 20);
        created(other.id, 30, 'consult');

        expect(
            database.createdSessions.list([creatorId], 10).map(({ sessionId }) => sessionId),
        ).toEqual([related]);
        expect(database.createdSessions.list([], 10)).toEqual([]);
    });
});

describe('CreatedSessionsModel results', () => {
    const result = (sessionId: string, delegationId: string, summary: string) => ({
        sessionId,
        delegationId,
        summary,
        source: 'authored' as const,
        completedAt: 5,
    });

    it('replaces the Session result with a later one and reads several at once', async () => {
        const { created, creatorId, database } = await fixture();
        const first = created(creatorId, 10, 'delegated');
        const second = created(creatorId, 20, 'consult');

        database.createdSessions.saveResult(result(first, 'task-1', 'Early.'));
        database.createdSessions.saveResult(result(first, 'task-2', 'Later.'));
        database.createdSessions.saveResult(result(second, 'task-3', 'Other.'));

        expect(database.createdSessions.results([first, second, creatorId])).toEqual(
            new Map([
                [first, result(first, 'task-2', 'Later.')],
                [second, result(second, 'task-3', 'Other.')],
            ]),
        );
        expect(database.createdSessions.results([])).toEqual(new Map());
    });

    it('deletes only the named Session result', async () => {
        const { created, creatorId, database } = await fixture();
        const first = created(creatorId, 10, 'delegated');
        const second = created(creatorId, 20, 'consult');
        database.createdSessions.saveResult(result(first, 'task-1', 'Early.'));
        database.createdSessions.saveResult(result(second, 'task-2', 'Other.'));

        database.createdSessions.deleteResult(first);
        database.createdSessions.deleteResult(creatorId);

        expect(database.createdSessions.results([first, second])).toEqual(
            new Map([[second, result(second, 'task-2', 'Other.')]]),
        );
    });

    it('outlives the Session being archived and goes with the Session being deleted', async () => {
        const { created, creatorId, database } = await fixture();
        const session = created(creatorId, 10, 'delegated');
        database.createdSessions.saveResult(result(session, 'task-1', 'Kept.'));

        database.database.prepare('UPDATE sessions SET archived_at = 1 WHERE id = ?').run(session);
        expect(database.createdSessions.results([session]).size).toBe(1);

        database.deleteSession(session);
        expect(database.createdSessions.results([session]).size).toBe(0);
    });
});
