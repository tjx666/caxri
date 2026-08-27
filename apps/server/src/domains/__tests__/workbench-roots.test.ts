import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEndpointSummary, NewWorktreeBehavior, ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../db/repository';
import type { GitService, GitWorktreeTopology } from '../git';
import { WorkbenchRootService } from '../workbench-roots';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    const pendingLoggers = loggers.slice();
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
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
    const events: ServerEvent[] = [];
    let behavior: NewWorktreeBehavior = 'ask';
    let topology: GitWorktreeTopology = {
        repositoryKey: join(directory, '.git'),
        worktrees: [{ branch: 'main', rootPath: ownerRoot }],
    };
    const worktreeTopology = vi.fn(() => Promise.resolve(topology));
    const logger = new StructuredLogger(join(directory, 'logs'));
    loggers.push(logger);
    const service = new WorkbenchRootService({
        behavior: () => behavior,
        database,
        emit: (event) => {
            events.push(event);
        },
        git: { worktreeTopology } as unknown as GitService,
        logger,
        ...options,
    });
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

function endpoint(
    context: Awaited<ReturnType<typeof fixture>>,
    generation = 1,
): AgentEndpointSummary {
    const created = context.sessions[0];
    return {
        ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation },
        projectId: context.owner.id,
        sessionId: created.session.id,
        terminalId: created.terminal!.id,
        provider: 'codex',
        name: 'Codex',
        permissionClass: 'standard',
        messaging: {
            deliveryMode: 'pull',
            health: 'ready',
            reason: 'pull_ready',
            checkedAt: Date.now(),
            nextAction: 'use_pull',
        },
        expiresAt: Date.now() + 60_000,
    };
}

function prime(
    context: Awaited<ReturnType<typeof fixture>>,
    agentEndpoint = endpoint(context),
): Promise<boolean> {
    return context.service.primeAgentEndpoint({
        projectId: agentEndpoint.projectId,
        provider: agentEndpoint.provider,
        ref: agentEndpoint.ref,
        sessionId: agentEndpoint.sessionId,
        terminalId: agentEndpoint.terminalId,
    });
}

function shellFinished(context: Awaited<ReturnType<typeof fixture>>) {
    const terminal = context.sessions[0].terminal!;
    return {
        launchId: 'launch-1',
        phase: 'shellToolFinished' as const,
        provider: 'codex' as const,
        terminalId: terminal.id,
    };
}

describe('WorkbenchRootService', () => {
    it('coalesces concurrent topology reads for the same owning Project', async () => {
        const context = await fixture();
        const pending = Promise.withResolvers<GitWorktreeTopology>();
        context.worktreeTopology.mockImplementationOnce(() => pending.promise);

        const reads = Promise.all([
            context.service.listOptions(context.sessions[0].session.id),
            context.service.listOptions(context.sessions[0].session.id),
        ]);
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(1));
        pending.resolve(context.getTopology());

        await expect(reads).resolves.toHaveLength(2);
        expect(context.worktreeTopology).toHaveBeenCalledTimes(1);
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

    it('waits for an in-flight Endpoint baseline before closing persistence', async () => {
        const context = await fixture();
        const pending = Promise.withResolvers<GitWorktreeTopology>();
        context.worktreeTopology.mockImplementationOnce(() => pending.promise);

        const priming = prime(context);
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(1));
        const closing = context.service.close();
        let isClosed = false;
        // eslint-disable-next-line no-void -- the test must observe close before the queued read settles.
        void closing.then(() => {
            isClosed = true;
        });
        await Promise.resolve();
        expect(isClosed).toBe(false);

        pending.resolve(context.getTopology());
        await priming;
        await closing;
        context.database.close();
    });

    it('does not attribute a uniquely added worktree from topology alone', async () => {
        const context = await fixture();
        await context.service.listOptions(context.sessions[0].session.id);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/external', rootPath: context.worktreeRoot },
        ]);

        await context.service.listOptions(context.sessions[0].session.id);
        expect(context.service.observeShellToolFinished(shellFinished(context))).toBe(true);

        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('bounds and coalesces shell deletion validation while structured Git is slow', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/selected', rootPath: context.worktreeRoot },
        ]);
        await context.service.authorizeSelection(
            context.sessions[0].session.id,
            context.worktreeRoot,
        );
        const callsBeforeSignals = context.worktreeTopology.mock.calls.length;
        const pending = Promise.withResolvers<GitWorktreeTopology>();
        context.worktreeTopology.mockImplementationOnce(() => pending.promise);
        vi.useFakeTimers();
        try {
            for (let index = 0; index < 1_000; index += 1)
                expect(context.service.observeShellToolFinished(shellFinished(context))).toBe(true);
            await vi.advanceTimersByTimeAsync(100);
            expect(context.worktreeTopology).toHaveBeenCalledTimes(callsBeforeSignals + 1);

            for (let index = 0; index < 1_000; index += 1)
                expect(context.service.observeShellToolFinished(shellFinished(context))).toBe(true);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(context.worktreeTopology).toHaveBeenCalledTimes(callsBeforeSignals + 1);

            pending.resolve(context.getTopology());
            await vi.waitFor(() =>
                expect(context.worktreeTopology).toHaveBeenCalledTimes(callsBeforeSignals + 2),
            );
        } finally {
            vi.useRealTimers();
        }
        await context.service.close();
        context.database.close();
    });

    it('does not let deletion validation absorb another added path into the launch baseline', async () => {
        const context = await fixture();
        const secondWorktreeRoot = join(context.directory, 'second-worktree');
        await mkdir(secondWorktreeRoot);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/selected', rootPath: context.worktreeRoot },
        ]);
        await context.service.authorizeSelection(
            context.sessions[0].session.id,
            context.worktreeRoot,
        );
        const agentEndpoint = endpoint(context);
        await prime(context, agentEndpoint);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/selected', rootPath: context.worktreeRoot },
            { branch: 'feature/reported', rootPath: secondWorktreeRoot },
        ]);

        expect(context.service.observeShellToolFinished(shellFinished(context))).toBe(true);
        await expect(
            context.service.reportCreatedWorktree(agentEndpoint, secondWorktreeRoot, () => true),
        ).resolves.toEqual({ status: 'accepted', action: 'candidate' });
        expect(
            context.events.filter((event) => event.event === 'workbench.candidate'),
        ).toHaveLength(1);
        await context.service.close();
        context.database.close();
    });

    it('fails closed when an Endpoint report has no pre-launch baseline', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/unproven', rootPath: context.worktreeRoot },
        ]);

        await expect(
            context.service.reportCreatedWorktree(
                endpoint(context),
                context.worktreeRoot,
                () => true,
            ),
        ).resolves.toEqual({ status: 'ignored', reason: 'baseline_missing' });
        expect(context.worktreeTopology).not.toHaveBeenCalled();
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('emits one candidate only for a newly linked path reported by the exact generation', async () => {
        const context = await fixture();
        const agentEndpoint = endpoint(context);
        await expect(prime(context, agentEndpoint)).resolves.toBe(true);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/proven', rootPath: context.worktreeRoot },
        ]);

        await expect(
            context.service.reportCreatedWorktree(agentEndpoint, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'accepted', action: 'candidate' });
        expect(
            context.events.filter((event) => event.event === 'workbench.candidate'),
        ).toHaveLength(1);
        await expect(
            context.service.reportCreatedWorktree(agentEndpoint, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'ignored', reason: 'path_preexisting' });
        expect(
            context.events.filter((event) => event.event === 'workbench.candidate'),
        ).toHaveLength(1);
        await context.service.close();
        context.database.close();
    });

    it('fences stale, mismatched, and retired Endpoint generations', async () => {
        const context = await fixture();
        const first = endpoint(context, 1);
        await prime(context, first);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/fenced', rootPath: context.worktreeRoot },
        ]);

        await expect(
            context.service.reportCreatedWorktree(first, context.worktreeRoot, () => false),
        ).resolves.toEqual({ status: 'ignored', reason: 'endpoint_unavailable' });
        await expect(
            context.service.reportCreatedWorktree(
                { ...first, sessionId: 'wrong-session' },
                context.worktreeRoot,
                () => true,
            ),
        ).resolves.toEqual({ status: 'ignored', reason: 'scope_mismatch' });

        context.setWorktrees([{ branch: 'main', rootPath: context.ownerRoot }]);
        const second = endpoint(context, 2);
        await prime(context, second);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/fenced', rootPath: context.worktreeRoot },
        ]);
        await expect(
            context.service.reportCreatedWorktree(first, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'ignored', reason: 'baseline_missing' });
        await expect(
            context.service.reportCreatedWorktree(second, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'accepted', action: 'candidate' });
        await context.service.close();
        context.database.close();
    });

    it('fails closed when current structured Git topology cannot prove the report', async () => {
        const context = await fixture();
        const agentEndpoint = endpoint(context);
        await prime(context, agentEndpoint);
        context.worktreeTopology.mockRejectedValueOnce(new Error('git unavailable'));

        await expect(
            context.service.reportCreatedWorktree(agentEndpoint, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'ignored', reason: 'topology_unavailable' });
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('supports explicit authorization without provenance and rejects unrelated directories', async () => {
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
        await context.service.close();
        context.database.close();
    });

    it('automatically selects a reported worktree only when it is already authorized', async () => {
        const context = await fixture();
        const worktreeProject = context.database.createProject(context.worktreeRoot);
        const agentEndpoint = endpoint(context);
        context.setBehavior('continueWhenAuthorized');
        await prime(context, agentEndpoint);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/authorized', rootPath: context.worktreeRoot },
        ]);

        await expect(
            context.service.reportCreatedWorktree(agentEndpoint, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'accepted', action: 'selected' });
        expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
            workbenchProjectId: worktreeProject.id,
            rootPath: context.worktreeRoot,
        });
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('accepts a recreated path only after validation proves its prior removal', async () => {
        const context = await fixture();
        const worktreeProject = context.database.createProject(context.worktreeRoot);
        const agentEndpoint = endpoint(context);
        context.setBehavior('continueWhenAuthorized');
        await prime(context, agentEndpoint);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/recreated', rootPath: context.worktreeRoot },
        ]);
        await expect(
            context.service.reportCreatedWorktree(agentEndpoint, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'accepted', action: 'selected' });

        context.setWorktrees([{ branch: 'main', rootPath: context.ownerRoot }]);
        expect(context.service.observeShellToolFinished(shellFinished(context))).toBe(true);
        await vi.waitFor(() =>
            expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
                workbenchProjectId: context.owner.id,
            }),
        );
        expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
            workbenchProjectId: context.owner.id,
        });

        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/recreated', rootPath: context.worktreeRoot },
        ]);
        await expect(
            context.service.reportCreatedWorktree(agentEndpoint, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'accepted', action: 'selected' });
        expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
            workbenchProjectId: worktreeProject.id,
        });
        await context.service.close();
        context.database.close();
    });

    it('rejects a stale candidate and falls back when an active worktree disappears', async () => {
        const context = await fixture();
        const agentEndpoint = endpoint(context);
        await prime(context, agentEndpoint);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/stale', rootPath: context.worktreeRoot },
        ]);
        await context.service.reportCreatedWorktree(
            agentEndpoint,
            context.worktreeRoot,
            () => true,
        );
        const candidate = context.events.find((event) => event.event === 'workbench.candidate');
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

    it('ignores a proven addition when configured to ignore new worktrees', async () => {
        const context = await fixture();
        const agentEndpoint = endpoint(context);
        context.setBehavior('ignore');
        await prime(context, agentEndpoint);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/ignored', rootPath: context.worktreeRoot },
        ]);

        await expect(
            context.service.reportCreatedWorktree(agentEndpoint, context.worktreeRoot, () => true),
        ).resolves.toEqual({ status: 'ignored', reason: 'behavior_ignored' });
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });
});
