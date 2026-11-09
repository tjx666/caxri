import { randomUUID } from 'node:crypto';
import { mkdir, realpath as realPath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { newSessionFixture } from './new-session.fixture';

/**
 * Builds a fixture plus a request that names a folder instead of a Project ID. The folder is created under the
 * fixture's temporary directory and is not a Project yet.
 */
async function pathFixture(folder = 'other-repo') {
    const fixture = await newSessionFixture();
    const path = join(fixture.directory, folder);
    await mkdir(path, { recursive: true });
    const { provider, prompt, newSession, title } = fixture.request;
    return {
        ...fixture,
        path,
        pathRequest: { provider, prompt, newSession, title, projectPath: path },
    };
}

function projectAddedFields(logger: { write: unknown }) {
    const write = logger.write as { mock: { calls: Array<[string, string, { fields: object }]> } };
    return write.mock.calls
        .filter(([, event]) => event === 'agent_delegation.project_added')
        .map((call) => call[2].fields);
}

describe('Delegation by folder (`projectPath`)', () => {
    it('adds the folder as a visible Project and runs the new Session in it', async () => {
        const { database, service, agentAuthority, path, pathRequest, events, logger } =
            await pathFixture();
        const id = randomUUID();

        const receipt = await service.create(id, agentAuthority, pathRequest);

        const added = database.findProjectByRootPath(await realPath(path))!;
        expect(added).toMatchObject({ rootPath: await realPath(path) });
        expect(added.hiddenAt).toBeUndefined();
        expect(added.ownerProjectId).toBeUndefined();
        expect(receipt.projectId).toBe(added.id);
        expect(database.getSession(receipt.sessionId)?.projectId).toBe(added.id);
        // The stored task references the Project by ID; the folder never reaches it.
        const stored = database.agentDelegations.get(id)!;
        expect(stored.input).toMatchObject({ projectId: added.id });
        expect(JSON.stringify(stored)).not.toContain(path);
        expect(events.filter((event) => event.event === 'state.changed')).toHaveLength(1);
        expect(projectAddedFields(logger)).toEqual([
            {
                outcome: 'created',
                principalKind: 'agent',
                durationMs: expect.any(Number) as number,
            },
        ]);
        expect(JSON.stringify(projectAddedFields(logger))).not.toContain(path);
    });

    it('reuses a Project already added for that folder', async () => {
        const { database, service, agentAuthority, path, pathRequest, logger } =
            await pathFixture();
        const existing = database.createProject(await realPath(path));
        const projectsBefore = database.listProjects().length;

        const receipt = await service.create(randomUUID(), agentAuthority, pathRequest);

        expect(receipt.projectId).toBe(existing.id);
        expect(database.listProjects()).toHaveLength(projectsBefore);
        expect(projectAddedFields(logger)).toMatchObject([{ outcome: 'existing' }]);
    });

    it('brings a hidden Project back, as `project add` does', async () => {
        const { database, service, agentAuthority, path, pathRequest, logger } =
            await pathFixture();
        const hidden = database.createProject(await realPath(path));
        database.hideProject(hidden.id);
        expect(database.getProject(hidden.id)?.hiddenAt).toBeDefined();

        const receipt = await service.create(randomUUID(), agentAuthority, pathRequest);

        expect(receipt.projectId).toBe(hidden.id);
        expect(database.getProject(hidden.id)?.hiddenAt).toBeUndefined();
        expect(projectAddedFields(logger)).toMatchObject([{ outcome: 'unhidden' }]);
    });

    it('runs in a registered worktree under its owner instead of promoting it to top level', async () => {
        const { database, service, agentAuthority, path, pathRequest, project, logger, events } =
            await pathFixture();
        const worktree = database.createProject(await realPath(path), project.id);
        const projectsBefore = database.listProjects().length;

        const receipt = await service.create(randomUUID(), agentAuthority, pathRequest);

        expect(database.getProject(worktree.id)?.ownerProjectId).toBe(project.id);
        expect(database.listProjects()).toHaveLength(projectsBefore);
        expect(receipt.projectId).toBe(project.id);
        const session = database.getSession(receipt.sessionId)!;
        expect(session.projectId).toBe(project.id);
        expect(session.workbenchRootProjectId).toBe(worktree.id);
        expect(events.filter((event) => event.event === 'state.changed')).toHaveLength(0);
        expect(projectAddedFields(logger)).toMatchObject([{ outcome: 'worktree' }]);
    });

    it('adds a registered worktree of a hidden Project the way `project add` does', async () => {
        const { database, service, agentAuthority, path, pathRequest, project, logger } =
            await pathFixture();
        const worktree = database.createProject(await realPath(path), project.id);
        database.hideProject(project.id);

        const receipt = await service.create(randomUUID(), agentAuthority, pathRequest);

        expect(receipt.projectId).toBe(worktree.id);
        expect(database.getProject(worktree.id)).toMatchObject({ id: worktree.id });
        expect(database.getProject(worktree.id)?.ownerProjectId).toBeUndefined();
        expect(projectAddedFields(logger)).toMatchObject([{ outcome: 'adopted_worktree' }]);
    });

    it('lets the owner CLI and the Desktop add a folder', async () => {
        const { database, service, pathRequest, path, callerTerminalId } = await pathFixture();
        const owner = { principal: { kind: 'human-cli' as const, id: 'owner', generation: 1 } };
        const desktop = {
            principal: { kind: 'desktop' as const, id: 'desktop', generation: 1 },
            callerTerminalId,
        };

        const first = await service.create(randomUUID(), owner, pathRequest);
        const second = await service.create(randomUUID(), desktop, pathRequest);

        expect(first.projectId).toBe(second.projectId);
        expect(database.findProjectByRootPath(await realPath(path))?.id).toBe(first.projectId);
    });

    it('runs a worktree in the Project it just added', async () => {
        const { database, service, agentAuthority, pathRequest, path } = await pathFixture();

        const receipt = await service.create(randomUUID(), agentAuthority, {
            ...pathRequest,
            worktreeBranch: 'feat',
        });

        const added = database.findProjectByRootPath(await realPath(path))!;
        const session = database.getSession(receipt.sessionId)!;
        expect(session.projectId).toBe(added.id);
        expect(session.workbenchRootProjectId).toBeDefined();
        expect(session.workbenchRootProjectId).not.toBe(added.id);
    });

    it('resolves a replay of the request ID to the recorded task without adding again', async () => {
        const { database, service, agentAuthority, pathRequest, events, logger } =
            await pathFixture();
        const id = randomUUID();
        const first = await service.create(id, agentAuthority, pathRequest);
        const projectsBefore = database.listProjects().length;
        const eventsBefore = events.length;

        const replay = await service.create(id, agentAuthority, pathRequest);

        expect(replay).toEqual(first);
        expect(database.listProjects()).toHaveLength(projectsBefore);
        expect(events).toHaveLength(eventsBefore);
        expect(projectAddedFields(logger)).toHaveLength(1);
    });

    it('joins two concurrent requests with one ID into one Project, Session and task', async () => {
        const { database, service, agentAuthority, pathRequest, logger } = await pathFixture();
        const id = randomUUID();
        const sessionsBefore = database.listSessions().length;
        const projectsBefore = database.listProjects().length;

        const [first, second] = await Promise.all([
            service.create(id, agentAuthority, pathRequest),
            service.create(id, agentAuthority, pathRequest),
        ]);

        expect(second).toEqual(first);
        expect(database.listProjects()).toHaveLength(projectsBefore + 1);
        expect(database.listSessions()).toHaveLength(sessionsBefore + 1);
        expect(projectAddedFields(logger)).toHaveLength(1);
    });

    it('refuses a replay naming another folder before adding it', async () => {
        const { database, service, agentAuthority, pathRequest, directory } = await pathFixture();
        const id = randomUUID();
        await service.create(id, agentAuthority, pathRequest);
        const other = join(directory, 'second-repo');
        await mkdir(other);
        const projectsBefore = database.listProjects().length;

        await expect(
            service.create(id, agentAuthority, { ...pathRequest, projectPath: other }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });

        expect(database.findProjectByRootPath(await realPath(other))).toBeUndefined();
        expect(database.listProjects()).toHaveLength(projectsBefore);
    });

    it('refuses a replay that names the Project by ID instead of the folder', async () => {
        const { service, agentAuthority, pathRequest } = await pathFixture();
        const id = randomUUID();
        const receipt = await service.create(id, agentAuthority, pathRequest);
        const { provider, prompt, newSession, title } = pathRequest;

        await expect(
            service.create(id, agentAuthority, {
                provider,
                prompt,
                newSession,
                title,
                projectId: receipt.projectId,
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('adds no Project for an external delegation identity', async () => {
        const { database, service, project, pathRequest, path } = await pathFixture();
        const bound = database.createSession(project.id, null);
        const projectsBefore = database.listProjects().length;

        await expect(
            service.create(
                randomUUID(),
                {
                    principal: {
                        kind: 'delegation-client',
                        id: 'external',
                        clientId: 'external-client',
                        generation: 1,
                        projectIds: [project.id] as [string],
                        sessionId: bound.session.id,
                        callerProvider: 'codex',
                    },
                },
                pathRequest,
            ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });

        expect(database.listProjects()).toHaveLength(projectsBefore);
        expect(database.findProjectByRootPath(await realPath(path))).toBeUndefined();
    });

    it('adds no Project for Caxri Bot, whose Sessions stay in its own Project', async () => {
        const { database, service, botAuthority, pathRequest } = await pathFixture();
        const projectsBefore = database.listProjects().length;

        await expect(service.create(randomUUID(), botAuthority, pathRequest)).rejects.toMatchObject(
            { code: 'FORBIDDEN' },
        );

        expect(database.listProjects()).toHaveLength(projectsBefore);
    });

    it('refuses a missing folder, a relative path and a file, and leaves no Session', async () => {
        const { database, service, agentAuthority, pathRequest, directory } = await pathFixture();
        const file = join(directory, 'a-file');
        await writeFile(file, 'x');
        const sessionsBefore = database.listSessions().length;
        const projectsBefore = database.listProjects().length;

        await Promise.all(
            [join(directory, 'missing'), 'relative/repo', file].map((projectPath) =>
                expect(
                    service.create(randomUUID(), agentAuthority, { ...pathRequest, projectPath }),
                ).rejects.toMatchObject({ code: 'PATH_DENIED' }),
            ),
        );

        expect(database.listSessions()).toHaveLength(sessionsBefore);
        expect(database.listProjects()).toHaveLength(projectsBefore);
    });

    it('refuses a title in the wrong language before adding the folder', async () => {
        const { database, service, agentAuthority, callerSessionId, pathRequest, path } =
            await pathFixture();
        database.renameSession(callerSessionId, '优化子模块的 CI 耗时');

        await expect(
            service.create(randomUUID(), agentAuthority, {
                ...pathRequest,
                title: 'Delegated task: schema tests',
            }),
        ).rejects.toThrow('Write the Session title in Chinese');

        expect(database.findProjectByRootPath(await realPath(path))).toBeUndefined();
    });

    it('keeps the Project when admission refuses the task afterwards, and removes the Session', async () => {
        const { database, service, agentAuthority, pathRequest, path } = await pathFixture();
        const sessionsBefore = database.listSessions().length;

        await expect(
            service.create(randomUUID(), agentAuthority, {
                ...pathRequest,
                provider: undefined,
                preset: 'missing-preset',
            }),
        ).rejects.toThrow();

        expect(database.findProjectByRootPath(await realPath(path))).toBeDefined();
        expect(database.listSessions()).toHaveLength(sessionsBefore);
    });
});
