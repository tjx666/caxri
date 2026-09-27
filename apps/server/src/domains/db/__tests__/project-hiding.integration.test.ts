import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

const directories: string[] = [];
const byId = (left: string, right: string) => left.localeCompare(right);
const connections: CaxriDatabase[] = [];
afterEach(async () => {
    for (const connection of connections) connection.close();
    connections.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-hiding-'));
    directories.push(directory);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    connections.push(database);
    const keeperRoot = join(directory, 'keeper');
    const hiddenRoot = join(directory, 'hidden');
    await Promise.all([mkdir(keeperRoot), mkdir(hiddenRoot)]);
    const keeper = database.createProject(keeperRoot);
    const keeperSession = database.createSession(keeper.id, 'shell').session;
    const project = database.createProject(hiddenRoot);
    const sessions = [
        database.createSession(project.id, 'shell').session,
        database.createSession(project.id, 'shell').session,
    ];
    return { database, directory, hiddenRoot, keeper, keeperSession, project, sessions };
}

describe('Project hiding', () => {
    it('removes a Project and its Sessions from the visible lists while keeping every row', async () => {
        const { database, keeper, keeperSession, project, sessions } = await fixture();

        const hidden = database.hideProject(project.id, 42);

        expect(hidden.map(({ id }) => id).toSorted(byId)).toEqual(
            sessions.map(({ id }) => id).toSorted(byId),
        );
        expect(database.listVisibleProjects().map(({ id }) => id)).toEqual([keeper.id]);
        expect(database.listVisibleSessions().map(({ id }) => id)).toEqual([keeperSession.id]);
        expect(database.getProject(project.id)?.hiddenAt).toBe(42);
        expect(database.listSessions(project.id)).toHaveLength(2);
    });

    it('restores only a hidden Project that still has an unarchived Session', async () => {
        const { database, hiddenRoot, project, sessions } = await fixture();
        expect(database.isRestorableProjectRoot(hiddenRoot)).toBe(false);

        database.hideProject(project.id);
        expect(database.isRestorableProjectRoot(hiddenRoot)).toBe(true);

        for (const session of sessions) database.archiveSession(session.id);
        expect(database.isRestorableProjectRoot(hiddenRoot)).toBe(false);
    });

    it('moves the selection off a hidden Project', async () => {
        const { database, keeper, keeperSession, project } = await fixture();
        expect(database.getAppState('lastSelectedProjectId')).toBe(project.id);

        database.hideProject(project.id);

        expect(database.getAppState('lastSelectedProjectId')).toBe(keeper.id);
        expect(database.getAppState('lastSelectedSessionId')).toBe(keeperSession.id);
    });

    it('restores the same Project and its Sessions when the root is added again', async () => {
        const { database, hiddenRoot, project, sessions } = await fixture();
        database.hideProject(project.id);

        const restored = database.createProject(hiddenRoot);

        expect(restored.id).toBe(project.id);
        expect(restored.hiddenAt).toBeUndefined();
        expect(restored.orderIndex).toBe(project.orderIndex);
        expect(
            database
                .listVisibleSessions()
                .filter((session) => session.projectId === project.id)
                .map(({ id }) => id)
                .toSorted(byId),
        ).toEqual(sessions.map(({ id }) => id).toSorted(byId));
    });

    it('hides owned worktree Projects with their owner and only a manual add brings them back', async () => {
        const { database, directory, hiddenRoot, project } = await fixture();
        const worktreeRoot = join(directory, 'hidden-worktree');
        await mkdir(worktreeRoot);
        const worktree = database.createProject(worktreeRoot, project.id);

        database.hideProject(project.id);
        expect(database.getProject(worktree.id)?.hiddenAt).toBeDefined();
        expect(() => database.hideProject(worktree.id)).toThrow(/top-level Project/);

        // An automatic worktree registration must not resurface a Project the user hid.
        expect(database.createProject(worktreeRoot, project.id).hiddenAt).toBeDefined();
        expect(database.createProject(hiddenRoot).hiddenAt).toBeUndefined();
        expect(database.getProject(worktree.id)?.hiddenAt).toBeUndefined();
    });
});
