import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../shared/ipc/events';
import { StructuredLogger } from '../../shared/node/logger';
import type { NewWorktreeBehavior } from '../../shared/types';
import { CaxriDatabase } from '../db/repository';
import type { GitService, GitWorktreeTopology } from '../git';
import { WorkbenchRootService } from '../workbench-roots';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function fixture(
    sessionCount = 1,
    options: { beforeRootIdentityRealpath?: () => Promise<void> } = {},
) {
    const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-roots-'));
    temporaryDirectories.push(createdDirectory);
    const directory = await realpath(createdDirectory);
    const ownerRoot = join(directory, 'owner');
    const worktreeRoot = join(directory, 'worktree');
    await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const owner = database.createProject(ownerRoot);
    const sessions = Array.from({ length: sessionCount }, () =>
        database.createSession(owner.id, 'codex'),
    );
    const events: RuntimeEvent[] = [];
    let behavior: NewWorktreeBehavior = 'ask';
    let topology: GitWorktreeTopology = {
        repositoryKey: join(directory, '.git'),
        worktrees: [{ branch: 'main', rootPath: ownerRoot }],
    };
    const worktreeTopology = vi.fn(() => Promise.resolve(topology));
    const service = new WorkbenchRootService({
        behavior: () => behavior,
        database,
        emit: (event) => events.push(event),
        git: { worktreeTopology } as unknown as GitService,
        logger: new StructuredLogger(join(directory, 'logs')),
        ...options,
    });
    await service.listOptions(sessions[0].session.id);
    return {
        database,
        directory,
        events,
        getTopology: () => topology,
        owner,
        ownerRoot,
        service,
        sessions,
        setBehavior: (value: NewWorktreeBehavior) => {
            behavior = value;
        },
        setWorktrees: (worktrees: GitWorktreeTopology['worktrees']) => {
            topology = { ...topology, worktrees };
        },
        worktreeRoot,
        worktreeTopology,
    };
}

function shellFinished(terminalId: string) {
    return {
        launchId: `launch-${terminalId}`,
        phase: 'shellToolFinished' as const,
        provider: 'codex' as const,
        terminalId,
    };
}

describe('WorkbenchRootService topology attribution', () => {
    it('coalesces concurrent topology reads for the same owning Project', async () => {
        const context = await fixture();
        const pending = Promise.withResolvers<GitWorktreeTopology>();
        context.worktreeTopology.mockImplementationOnce(() => pending.promise);

        const reads = Promise.all([
            context.service.listOptions(context.sessions[0].session.id),
            context.service.listOptions(context.sessions[0].session.id),
        ]);
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
        pending.resolve(context.getTopology());

        await expect(reads).resolves.toHaveLength(2);
        expect(context.worktreeTopology).toHaveBeenCalledTimes(2);
        await context.service.close();
        context.database.close();
    });

    it('does not let stale validation overwrite a newer Workbench Root selection', async () => {
        const context = await fixture();
        const secondWorktreeRoot = join(context.directory, 'second-worktree');
        await mkdir(secondWorktreeRoot);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/first', rootPath: context.worktreeRoot },
            { branch: 'feature/second', rootPath: secondWorktreeRoot },
        ]);
        const firstSelection = await context.service.authorizeSelection(
            context.sessions[0].session.id,
            context.worktreeRoot,
        );
        const secondProject = context.database.createProject(secondWorktreeRoot);
        const internals = context.service as unknown as {
            rootIdentity(rootPath: string): Promise<{ device: string; inode: string }>;
        };
        const originalRootIdentity = internals.rootIdentity.bind(context.service);
        const pendingIdentity = Promise.withResolvers<{ device: string; inode: string }>();
        const identity = vi
            .spyOn(internals, 'rootIdentity')
            .mockImplementation((rootPath) =>
                rootPath === context.worktreeRoot
                    ? pendingIdentity.promise
                    : originalRootIdentity(rootPath),
            );
        const fallbackCount = context.events.filter(
            (event) => event.event === 'workbench.changed' && event.payload.reason === 'fallback',
        ).length;

        const validation = context.service.validateSession(context.sessions[0].session.id);
        await vi.waitFor(() => expect(identity).toHaveBeenCalledWith(context.worktreeRoot));
        await context.service.select(context.sessions[0].session.id, secondProject.id);
        pendingIdentity.resolve({ device: 'stale-device', inode: 'stale-inode' });

        await expect(validation).resolves.toBe(false);
        expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
            projectId: context.owner.id,
            workbenchProjectId: secondProject.id,
            rootPath: secondWorktreeRoot,
        });
        expect(
            context.events.filter(
                (event) =>
                    event.event === 'workbench.changed' && event.payload.reason === 'fallback',
            ),
        ).toHaveLength(fallbackCount);
        expect(firstSelection.workbenchProjectId).not.toBe(secondProject.id);
        await context.service.close();
        context.database.close();
    });

    it('shares one topology read while validating Sessions with the same owner', async () => {
        const context = await fixture(2);
        const secondWorktreeRoot = join(context.directory, 'second-worktree');
        await mkdir(secondWorktreeRoot);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/first', rootPath: context.worktreeRoot },
            { branch: 'feature/second', rootPath: secondWorktreeRoot },
        ]);
        const firstProject = context.database.createProject(context.worktreeRoot);
        const secondProject = context.database.createProject(secondWorktreeRoot);
        await context.service.select(context.sessions[0].session.id, firstProject.id);
        await context.service.select(context.sessions[1].session.id, secondProject.id);
        context.worktreeTopology.mockClear();

        await context.service.validate();

        expect(context.worktreeTopology).toHaveBeenCalledTimes(1);
        await context.service.close();
        context.database.close();
    });

    it('bounds startup topology priming to the most recent owner Projects', async () => {
        const context = await fixture();
        for (let index = 0; index < 40; index += 1) {
            const rootPath = join(context.directory, `owner-${index}`);
            await mkdir(rootPath);
            const created = context.database.createSession(
                context.database.createProject(rootPath).id,
                'shell',
            );
            context.database.closeTerminal(created.terminal!.id);
        }
        context.worktreeTopology.mockClear();
        const internals = context.service as unknown as { queue: Promise<void> };

        context.service.primeAll();
        await internals.queue;

        expect(context.worktreeTopology).toHaveBeenCalledTimes(32);
        await context.service.close();
        context.database.close();
    });

    it('rejects a root replaced between its identity read and canonicalization', async () => {
        let swapRoot: (() => Promise<void>) | undefined;
        const context = await fixture(1, {
            beforeRootIdentityRealpath: async () => swapRoot?.(),
        });
        const displacedRoot = join(context.directory, 'displaced-worktree');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/replaced', rootPath: context.worktreeRoot },
        ]);
        swapRoot = async () => {
            swapRoot = undefined;
            await rename(context.worktreeRoot, displacedRoot);
            await mkdir(context.worktreeRoot);
        };

        await expect(
            context.service.authorizeSelection(
                context.sessions[0].session.id,
                context.worktreeRoot,
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();
        await context.service.close();
        context.database.close();
    });

    it('waits for an in-flight topology prime before closing persistence', async () => {
        const context = await fixture();
        const pending = Promise.withResolvers<GitWorktreeTopology>();
        context.worktreeTopology.mockImplementationOnce(() => pending.promise);

        context.service.primeAll();
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
        const closing = context.service.close();
        let closed = false;
        void closing.then(() => {
            closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);

        pending.resolve(context.getTopology());
        await closing;
        context.database.close();
    });

    it('emits one content-free candidate for one uniquely added worktree', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/one', rootPath: context.worktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context.sessions[0].terminal!.id),
            ),
        ).toBe(true);

        await vi.waitFor(() =>
            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1),
        );
        const candidate = context.events.find((event) => event.event === 'workbench.candidate');
        expect(candidate).toMatchObject({
            event: 'workbench.candidate',
            payload: { sessionId: context.sessions[0].session.id },
        });
        if (candidate?.event === 'workbench.candidate')
            expect(
                context.service.claimCandidate(
                    context.sessions[0].session.id,
                    candidate.payload.candidateId,
                ),
            ).toMatchObject({ rootPath: context.worktreeRoot });
        await context.service.close();
        context.database.close();
    });

    it('fails closed when two Sessions signal for the same repository batch', async () => {
        const context = await fixture(2);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/shared', rootPath: context.worktreeRoot },
        ]);

        for (const created of context.sessions)
            context.service.observeShellToolFinished(shellFinished(created.terminal!.id));

        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('fails closed when one topology refresh contains multiple additions', async () => {
        const context = await fixture();
        const secondRoot = join(temporaryDirectories[0], 'second-worktree');
        await mkdir(secondRoot);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/one', rootPath: context.worktreeRoot },
            { branch: 'feature/two', rootPath: secondRoot },
        ]);

        context.service.observeShellToolFinished(shellFinished(context.sessions[0].terminal!.id));

        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('supports explicit authorization without hooks and rejects unrelated directories', async () => {
        const context = await fixture();
        const unrelatedRoot = join(context.directory, 'unrelated');
        await mkdir(unrelatedRoot);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/manual', rootPath: context.worktreeRoot },
        ]);

        await expect(
            context.service.authorizeSelection(context.sessions[0].session.id, unrelatedRoot),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        expect(context.database.findProjectByRootPath(unrelatedRoot)).toBeUndefined();

        const selected = await context.service.authorizeSelection(
            context.sessions[0].session.id,
            context.worktreeRoot,
        );
        expect(selected).toMatchObject({
            projectId: context.owner.id,
            rootPath: context.worktreeRoot,
        });
        expect(typeof selected.workbenchProjectId).toBe('string');
        expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
            projectId: context.owner.id,
            rootPath: context.worktreeRoot,
        });
        await context.service.close();
        context.database.close();
    });

    it('automatically selects a uniquely added worktree only when it is already authorized', async () => {
        const context = await fixture();
        const worktreeProject = context.database.createProject(context.worktreeRoot);
        context.setBehavior('continueWhenAuthorized');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/authorized', rootPath: context.worktreeRoot },
        ]);

        context.service.observeShellToolFinished(shellFinished(context.sessions[0].terminal!.id));

        await vi.waitFor(() =>
            expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
                workbenchProjectId: worktreeProject.id,
                rootPath: context.worktreeRoot,
            }),
        );
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        expect(context.database.getTerminal(context.sessions[0].terminal!.id)).toMatchObject({
            cwd: context.ownerRoot,
            id: context.sessions[0].terminal!.id,
        });
        await context.service.close();
        context.database.close();
    });

    it('rejects a stale candidate and falls back when an active worktree disappears', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/stale', rootPath: context.worktreeRoot },
        ]);
        context.service.observeShellToolFinished(shellFinished(context.sessions[0].terminal!.id));
        await vi.waitFor(() =>
            expect(context.events.some((event) => event.event === 'workbench.candidate')).toBe(
                true,
            ),
        );
        const candidate = context.events.find((event) => event.event === 'workbench.candidate');
        expect(candidate?.event).toBe('workbench.candidate');
        if (candidate?.event !== 'workbench.candidate') throw new Error('Candidate not emitted');
        context.service.claimCandidate(
            context.sessions[0].session.id,
            candidate.payload.candidateId,
        );
        context.setWorktrees([{ branch: 'main', rootPath: context.ownerRoot }]);
        await expect(
            context.service.authorizeCandidate(
                context.sessions[0].session.id,
                candidate.payload.candidateId,
                context.worktreeRoot,
            ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();

        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/stale', rootPath: context.worktreeRoot },
        ]);
        await context.service.authorizeSelection(
            context.sessions[0].session.id,
            context.worktreeRoot,
        );
        await rm(context.worktreeRoot, { recursive: true });
        await expect(context.service.validateSession(context.sessions[0].session.id)).resolves.toBe(
            true,
        );
        expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
            workbenchProjectId: context.owner.id,
            rootPath: context.ownerRoot,
        });
        expect(context.events.at(-1)).toMatchObject({
            event: 'workbench.changed',
            payload: {
                reason: 'fallback',
                returnedProjectTitle: context.owner.displayTitle,
            },
        });
        await context.service.close();
        context.database.close();
    });

    it('ignores a unique addition when the configured behavior is Ignore', async () => {
        const context = await fixture();
        context.setBehavior('ignore');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/ignored', rootPath: context.worktreeRoot },
        ]);

        context.service.observeShellToolFinished(shellFinished(context.sessions[0].terminal!.id));

        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });
});
