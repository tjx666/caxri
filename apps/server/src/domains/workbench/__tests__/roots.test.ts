import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { GitWorktreeTopology } from '../../git/index';
import {
    beginWorktreeCreation,
    fixture,
    prime,
    shellFailed,
    shellFinished,
    shellStarted,
} from './roots.fixture';

describe('WorkbenchRootService worktree attribution', () => {
    it('waits for an in-flight Agent launch baseline before closing persistence', async () => {
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
        expect(context.service.observeShellToolFinished(shellFinished(context))).toBe('accepted');

        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('emits a candidate when the current Agent hook observes a worktree creation', async () => {
        const context = await fixture();
        await prime(context);
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/hook-created', rootPath: context.worktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');

        await vi.waitFor(() =>
            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1),
        );
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
                expect(context.service.observeShellToolFinished(shellFinished(context))).toBe(
                    'accepted',
                );
            await vi.advanceTimersByTimeAsync(100);
            expect(context.worktreeTopology).toHaveBeenCalledTimes(callsBeforeSignals + 1);

            for (let index = 0; index < 1_000; index += 1)
                expect(context.service.observeShellToolFinished(shellFinished(context))).toBe(
                    'accepted',
                );
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
        await prime(context);
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/selected', rootPath: context.worktreeRoot },
            { branch: 'feature/reported', rootPath: secondWorktreeRoot },
        ]);

        expect(context.service.observeShellToolFinished(shellFinished(context))).toBe('accepted');
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() =>
            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1),
        );
        await context.service.close();
        context.database.close();
    });

    it('never falls back to the launch baseline when the matching PreToolUse hook is missing', async () => {
        const context = await fixture();
        await prime(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/unpaired', rootPath: context.worktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(1));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('discards the paired snapshot when Claude reports that the Bash tool failed', async () => {
        const context = await fixture();
        await prime(context);
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/external', rootPath: context.worktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFailed(
                shellFailed(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('consumes a Codex outcome with no topology delta before any later addition can be claimed', async () => {
        const context = await fixture();
        await prime(context);
        await beginWorktreeCreation(context);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(3));
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/external', rootPath: context.worktreeRoot },
        ]);
        vi.useFakeTimers();
        try {
            expect(
                context.service.observeShellToolFinished(
                    shellFinished(context, { worktreeCreateIntent: true }),
                ),
            ).toBe('accepted');
            await vi.advanceTimersByTimeAsync(100);
        } finally {
            vi.useRealTimers();
        }
        expect(context.worktreeTopology).toHaveBeenCalledTimes(3);
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('emits one candidate only for a newly linked path observed by the exact launch', async () => {
        const context = await fixture();
        await expect(prime(context)).resolves.toBe(true);
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/proven', rootPath: context.worktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() =>
            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1),
        );
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(3));
        expect(
            context.events.filter((event) => event.event === 'workbench.candidate'),
        ).toHaveLength(1);
        await context.service.close();
        context.database.close();
    });

    it('consumes the pair without attribution when one command overlaps multiple additions', async () => {
        const context = await fixture();
        const secondWorktreeRoot = join(context.directory, 'second-worktree');
        await mkdir(secondWorktreeRoot);
        await prime(context);
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/first', rootPath: context.worktreeRoot },
            { branch: 'feature/second', rootPath: secondWorktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(3));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);

        await beginWorktreeCreation(context, { toolUseId: 'tool-use-2' });
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, {
                    toolUseId: 'tool-use-2',
                    worktreeCreateIntent: true,
                }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(5));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('fails closed when two Sessions report creation intent for the same repository batch', async () => {
        const context = await fixture(2);
        await prime(context, 'launch-1', 0);
        await prime(context, 'launch-2', 1);
        await beginWorktreeCreation(context, { launchId: 'launch-1' });
        await beginWorktreeCreation(context, {
            launchId: 'launch-2',
            sessionIndex: 1,
        });
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/ambiguous', rootPath: context.worktreeRoot },
        ]);

        vi.useFakeTimers();
        try {
            expect(
                context.service.observeShellToolFinished(
                    shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
                ),
            ).toBe('accepted');
            expect(
                context.service.observeShellToolFinished(
                    shellFinished(context, {
                        launchId: 'launch-2',
                        sessionIndex: 1,
                        worktreeCreateIntent: true,
                    }),
                ),
            ).toBe('accepted');
            await vi.advanceTimersByTimeAsync(100);
        } finally {
            vi.useRealTimers();
        }
        expect(context.worktreeTopology).toHaveBeenCalledTimes(3);
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);

        await beginWorktreeCreation(context, {
            launchId: 'launch-1',
            toolUseId: 'tool-use-2',
        });
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, {
                    launchId: 'launch-1',
                    toolUseId: 'tool-use-2',
                    worktreeCreateIntent: true,
                }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(5));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('keeps overlapping creation windows ambiguous across staggered outcome batches', async () => {
        const context = await fixture(2);
        await prime(context, 'launch-1', 0);
        await prime(context, 'launch-2', 1);
        await beginWorktreeCreation(context, { launchId: 'launch-1' });
        await beginWorktreeCreation(context, {
            launchId: 'launch-2',
            sessionIndex: 1,
        });
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/ambiguous', rootPath: context.worktreeRoot },
        ]);

        vi.useFakeTimers();
        try {
            expect(
                context.service.observeShellToolFinished(
                    shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
                ),
            ).toBe('accepted');
            await vi.advanceTimersByTimeAsync(100);
            expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual(
                [],
            );

            expect(
                context.service.observeShellToolFinished(
                    shellFinished(context, {
                        launchId: 'launch-2',
                        sessionIndex: 1,
                        worktreeCreateIntent: true,
                    }),
                ),
            ).toBe('accepted');
            await vi.advanceTimersByTimeAsync(100);
        } finally {
            vi.useRealTimers();
        }
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('bounds classified PreToolUse admission before serialized topology reads', async () => {
        const context = await fixture();
        await prime(context);
        const pending = Promise.withResolvers<GitWorktreeTopology>();
        context.worktreeTopology.mockImplementationOnce(() => pending.promise);

        const first = context.service.observeShellToolStarted(
            shellStarted(context, {
                toolUseId: 'tool-use-0',
                worktreeCreateIntent: true,
            }),
            () => true,
        );
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
        const remaining = Array.from({ length: 999 }, (_, index) =>
            context.service.observeShellToolStarted(
                shellStarted(context, {
                    toolUseId: `tool-use-${index + 1}`,
                    worktreeCreateIntent: true,
                }),
                () => true,
            ),
        );
        pending.resolve(context.getTopology());

        await Promise.all([first, ...remaining]);
        expect(context.worktreeTopology).toHaveBeenCalledTimes(2);
        await context.service.close();
        context.database.close();
    });

    it('fences stale and retired hook launches', async () => {
        const context = await fixture();
        await prime(context, 'launch-1');
        context.setWorktrees([{ branch: 'main', rootPath: context.ownerRoot }]);
        await prime(context, 'launch-2');
        await expect(
            context.service.observeShellToolStarted(
                shellStarted(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
                () => false,
            ),
        ).resolves.toBe('staleLaunch');
        await beginWorktreeCreation(context, { launchId: 'launch-2' });
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/fenced', rootPath: context.worktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, {
                    launchId: 'launch-1',
                    worktreeCreateIntent: true,
                }),
            ),
        ).toBe('accepted');
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, {
                    launchId: 'launch-2',
                    worktreeCreateIntent: true,
                }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() =>
            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1),
        );
        await context.service.close();
        context.database.close();
    });

    it('fails closed when current structured Git topology cannot prove the hook intent', async () => {
        const context = await fixture();
        await prime(context);
        context.worktreeTopology.mockRejectedValueOnce(new Error('git unavailable'));
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/unproven', rootPath: context.worktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
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

    it.each(['immediate', 'delayed claim', 'delayed authorization', 'delayed dismiss'])(
        'keeps an available worktree suggestion actionable: %s',
        async (action) => {
            const context = await fixture();
            await prime(context);
            await beginWorktreeCreation(context);
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature/attributed', rootPath: context.worktreeRoot },
            ]);
            expect(
                context.service.observeShellToolFinished(
                    shellFinished(context, { worktreeCreateIntent: true }),
                ),
            ).toBe('accepted');
            await vi.waitFor(() =>
                expect(
                    context.events.filter((event) => event.event === 'workbench.candidate'),
                ).toHaveLength(1),
            );
            const candidate = context.events.find((event) => event.event === 'workbench.candidate');
            if (candidate?.event !== 'workbench.candidate')
                throw new Error('Candidate not emitted');
            expect(candidate.payload.rootPath).toBe(context.worktreeRoot);
            const later = Date.now() + 24 * 60 * 60_000;
            const clock = vi.spyOn(Date, 'now');
            try {
                if (action === 'delayed claim' || action === 'delayed dismiss')
                    clock.mockReturnValue(later);
                if (action === 'delayed dismiss') {
                    expect(() =>
                        context.service.dismissCandidate(
                            context.sessions[0].session.id,
                            candidate.payload.candidateId,
                        ),
                    ).not.toThrow();
                    expect(
                        context.database.getSession(context.sessions[0].session.id)
                            ?.workbenchProjectId,
                    ).toBe(context.owner.id);
                    return;
                }
                context.service.claimCandidate(
                    context.sessions[0].session.id,
                    candidate.payload.candidateId,
                );
                if (action === 'delayed authorization') clock.mockReturnValue(later);
                await context.service.authorizeCandidate(
                    context.sessions[0].session.id,
                    candidate.payload.candidateId,
                    context.worktreeRoot,
                );
                expect(context.database.findProjectByRootPath(context.worktreeRoot)).toMatchObject({
                    ownerProjectId: context.owner.id,
                });
                // Hidden from the PrimarySidebar, but the Workbench Root picker must still offer it.
                await expect(
                    context.service.listOptions(context.sessions[0].session.id),
                ).resolves.toMatchObject([
                    { owner: true, projectId: context.owner.id },
                    { branch: 'feature/attributed', owner: false },
                ]);
            } finally {
                clock.mockRestore();
                await context.service.close();
                context.database.close();
            }
        },
    );

    it('attributes an explicitly selected worktree, but never re-owns a manually added root', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/selected', rootPath: context.worktreeRoot },
        ]);

        await context.service.authorizeSelection(
            context.sessions[0].session.id,
            context.worktreeRoot,
        );

        expect(context.database.findProjectByRootPath(context.worktreeRoot)).toMatchObject({
            ownerProjectId: context.owner.id,
        });
        await context.service.close();
        context.database.close();

        const manual = await fixture();
        manual.setWorktrees([
            { branch: 'main', rootPath: manual.ownerRoot },
            { branch: 'feature/manual', rootPath: manual.worktreeRoot },
        ]);
        // The user added this worktree as its own Project before any Session ever worked in it.
        manual.database.createProject(manual.worktreeRoot);

        await manual.service.authorizeSelection(manual.sessions[0].session.id, manual.worktreeRoot);

        expect(manual.database.findProjectByRootPath(manual.worktreeRoot)).not.toHaveProperty(
            'ownerProjectId',
        );
        await manual.service.close();
        manual.database.close();
    });

    it.each([
        ['continueWhenAuthorized', true],
        ['continueAutomatically', true],
        ['continueAutomatically', false],
    ] as const)(
        'follows attributed worktrees in %s mode with prior authorization %s',
        async (behavior, previouslyAuthorized) => {
            const context = await fixture();
            if (previouslyAuthorized) context.database.createProject(context.worktreeRoot);
            context.setBehavior(behavior);
            await prime(context);
            await beginWorktreeCreation(context);
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature/authorized', rootPath: context.worktreeRoot },
            ]);

            expect(
                context.service.observeShellToolFinished(
                    shellFinished(context, { worktreeCreateIntent: true }),
                ),
            ).toBe('accepted');
            await vi.waitFor(() =>
                expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
                    rootPath: context.worktreeRoot,
                }),
            );
            expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual(
                [],
            );
            const project = context.database.findProjectByRootPath(context.worktreeRoot);
            expect(project).toBeDefined();
            if (!previouslyAuthorized) expect(project?.ownerProjectId).toBe(context.owner.id);
            expect(
                context.database.getSession(context.sessions[0].session.id)?.workbenchProjectId,
            ).toBe(project?.id);
            await context.service.close();
            context.database.close();
        },
    );

    it('accepts a recreated path only after validation proves its prior removal', async () => {
        const context = await fixture();
        const worktreeProject = context.database.createProject(context.worktreeRoot);
        context.setBehavior('continueWhenAuthorized');
        await prime(context);
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/recreated', rootPath: context.worktreeRoot },
        ]);
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() =>
            expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
                workbenchProjectId: worktreeProject.id,
            }),
        );

        context.setWorktrees([{ branch: 'main', rootPath: context.ownerRoot }]);
        expect(context.service.observeShellToolFinished(shellFinished(context))).toBe('accepted');
        await vi.waitFor(() =>
            expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
                workbenchProjectId: context.owner.id,
            }),
        );
        expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
            workbenchProjectId: context.owner.id,
        });

        await beginWorktreeCreation(context, { toolUseId: 'tool-use-2' });
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/recreated', rootPath: context.worktreeRoot },
        ]);
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, {
                    toolUseId: 'tool-use-2',
                    worktreeCreateIntent: true,
                }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() =>
            expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
                workbenchProjectId: worktreeProject.id,
            }),
        );
        await context.service.close();
        context.database.close();
    });

    it('rejects a stale candidate and falls back when an active worktree disappears', async () => {
        const context = await fixture();
        await prime(context);
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/stale', rootPath: context.worktreeRoot },
        ]);
        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() =>
            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1),
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
        context.setBehavior('ignore');
        await prime(context);
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/ignored', rootPath: context.worktreeRoot },
        ]);

        expect(
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            ),
        ).toBe('accepted');
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(3));
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });
});
