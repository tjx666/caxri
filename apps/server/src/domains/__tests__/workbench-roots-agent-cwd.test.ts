import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { GitWorktreeTopology } from '../git';
import {
    agentCwdSignal,
    beginWorktreeCreation,
    fixture,
    prime,
    shellFinished,
} from './workbench-roots.fixture';

/**
 * Claude Code's built-in `EnterWorktree` moves the Agent's own directory without running a shell command, and its
 * `path` mode enters a worktree that already exists, so the paired-snapshot attribution covered by
 * `workbench-roots.test.ts` cannot observe it at all. These cover the independent path that reconciles the provider's
 * reported directory against Git topology.
 *
 * @see https://github.com/tjx666/caxri/issues/575
 */
describe('WorkbenchRootService reported Agent working directory', () => {
    it('records a proven worktree divergence and offers it as a candidate', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/entered', rootPath: context.worktreeRoot },
        ]);
        const terminal = context.sessions[0].terminal!;

        context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));

        await vi.waitFor(() =>
            expect(context.database.getTerminal(terminal.id)?.agentCwd).toBe(context.worktreeRoot),
        );
        await vi.waitFor(() =>
            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1),
        );
        expect(
            context.events.find((event) => event.event === 'workbench.candidate')?.payload,
        ).toMatchObject({ sessionId: context.sessions[0].session.id });
        // The Terminal's authorized launch root is never rewritten by a provider report.
        expect(context.database.getTerminal(terminal.id)?.cwd).toBe(context.ownerRoot);
        await context.service.close();
        context.database.close();
    });

    it.each(['ask', 'continueAutomatically'] as const)(
        'rejects directories outside worktree topology in %s mode',
        async (behavior) => {
            const context = await fixture();
            context.setBehavior(behavior);
            const nested = join(context.ownerRoot, 'packages');
            await mkdir(nested);
            const terminal = context.sessions[0].terminal!;

            context.service.observeAgentCwd(agentCwdSignal(context, nested));
            context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));

            await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
            await prime(context);
            expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();
            expect(context.database.findProjectByRootPath(nested)).toBeUndefined();
            expect(context.database.getTerminal(terminal.id)?.agentCwd).toBeUndefined();
            expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual(
                [],
            );
            await context.service.close();
            context.database.close();
        },
    );

    it('discards a reported directory that does not exist', async () => {
        const context = await fixture();
        const terminal = context.sessions[0].terminal!;

        context.service.observeAgentCwd(
            agentCwdSignal(context, join(context.directory, 'missing')),
        );

        await vi.waitFor(() => expect(context.worktreeTopology).not.toHaveBeenCalled());
        expect(context.database.getTerminal(terminal.id)?.agentCwd).toBeUndefined();
        await context.service.close();
        context.database.close();
    });

    it('reads Git topology once while the reported directory is unchanged', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/entered', rootPath: context.worktreeRoot },
        ]);

        context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(1));
        context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));
        context.service.observeAgentCwd(
            agentCwdSignal(context, context.worktreeRoot, { phase: 'turnFinished' }),
        );

        await vi.waitFor(() =>
            expect(context.database.getTerminal(context.sessions[0].terminal!.id)?.agentCwd).toBe(
                context.worktreeRoot,
            ),
        );
        expect(context.worktreeTopology).toHaveBeenCalledTimes(1);
        await context.service.close();
        context.database.close();
    });

    it('still records the divergence when new worktrees are configured to be ignored', async () => {
        const context = await fixture();
        context.setBehavior('ignore');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/entered', rootPath: context.worktreeRoot },
        ]);

        context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));

        await vi.waitFor(() =>
            expect(context.database.getTerminal(context.sessions[0].terminal!.id)?.agentCwd).toBe(
                context.worktreeRoot,
            ),
        );
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('automatically authorizes and selects a verified Agent worktree without asking', async () => {
        const context = await fixture();
        context.setBehavior('continueAutomatically');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/entered', rootPath: context.worktreeRoot },
        ]);

        context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));

        await vi.waitFor(() =>
            expect(context.database.getSession(context.sessions[0].session.id)?.rootPath).toBe(
                context.worktreeRoot,
            ),
        );
        expect(context.database.findProjectByRootPath(context.worktreeRoot)).toMatchObject({
            ownerProjectId: context.owner.id,
        });
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        expect(context.database.getTerminal(context.sessions[0].terminal!.id)?.cwd).toBe(
            context.ownerRoot,
        );
        await context.service.close();
        context.database.close();
    });

    it.each(['agentCwd', 'worktreeAdd'] as const)(
        'preserves a manual root selection during the first %s topology read',
        async (source) => {
            const context = await fixture();
            context.setBehavior('continueAutomatically');
            if (source === 'worktreeAdd') {
                await prime(context);
                await beginWorktreeCreation(context);
            }
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature/entered', rootPath: context.worktreeRoot },
            ]);
            const pending = Promise.withResolvers<GitWorktreeTopology>();
            context.worktreeTopology.mockClear();
            context.worktreeTopology.mockImplementationOnce(() => pending.promise);
            if (source === 'agentCwd')
                context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));
            else
                context.service.observeShellToolFinished(
                    shellFinished(context, { worktreeCreateIntent: true }),
                );
            await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(1));

            const manualRoot = join(context.directory, 'manual');
            await mkdir(manualRoot);
            const manual = context.database.createProject(manualRoot, context.owner.id);
            context.database.selectWorkbenchProject(context.sessions[0].session.id, manual.id);
            pending.resolve(context.getTopology());
            await prime(context);

            expect(context.database.getSession(context.sessions[0].session.id)?.rootPath).toBe(
                manualRoot,
            );
            expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();
            expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual(
                [],
            );
            await context.service.close();
            context.database.close();
        },
    );

    it.each(['setting', 'retirement', 'selection'] as const)(
        'does not authorize a worktree when %s changes during its identity check',
        async (change) => {
            const checking = Promise.withResolvers<void>();
            const resume = Promise.withResolvers<void>();
            const context = await fixture(1, {
                beforeRootIdentityRealpath: () => {
                    checking.resolve();
                    return resume.promise;
                },
            });
            context.setBehavior('continueAutomatically');
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature/entered', rootPath: context.worktreeRoot },
            ]);
            context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));
            await checking.promise;
            let expectedRoot = context.ownerRoot;
            if (change === 'setting') context.setBehavior('ask');
            else if (change === 'retirement')
                context.service.retireTerminal(context.sessions[0].terminal!.id);
            else {
                const otherRoot = join(context.directory, 'manual');
                await mkdir(otherRoot);
                const other = context.database.createProject(otherRoot, context.owner.id);
                context.database.selectWorkbenchProject(context.sessions[0].session.id, other.id);
                expectedRoot = otherRoot;
            }
            resume.resolve();
            // Drain reconciliation without closing the service and invalidating its guards.
            await prime(context);
            expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();
            expect(context.database.getSession(context.sessions[0].session.id)?.rootPath).toBe(
                expectedRoot,
            );
            expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual(
                [],
            );
            await context.service.close();
            context.database.close();
        },
    );

    it.each(['ask', 'continueWhenAuthorized'] as const)(
        'still asks for a new worktree in %s mode',
        async (behavior) => {
            const context = await fixture();
            context.setBehavior(behavior);
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature/entered', rootPath: context.worktreeRoot },
            ]);
            context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));
            await vi.waitFor(() =>
                expect(
                    context.events.filter((event) => event.event === 'workbench.candidate'),
                ).toHaveLength(1),
            );
            expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();
            expect(context.database.getSession(context.sessions[0].session.id)?.rootPath).toBe(
                context.ownerRoot,
            );
            await context.service.close();
            context.database.close();
        },
    );

    it('continues into an already authorized worktree without asking', async () => {
        const context = await fixture();
        context.setBehavior('continueWhenAuthorized');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/entered', rootPath: context.worktreeRoot },
        ]);
        const authorized = context.database.createProject(context.worktreeRoot);

        context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));

        await vi.waitFor(() =>
            expect(
                context.database.getSession(context.sessions[0].session.id)?.workbenchProjectId,
            ).toBe(authorized.id),
        );
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('clears the divergence when the Agent returns to the launch root', async () => {
        const context = await fixture();
        context.setBehavior('ignore');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/entered', rootPath: context.worktreeRoot },
        ]);
        const terminal = context.sessions[0].terminal!;

        context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));
        await vi.waitFor(() =>
            expect(context.database.getTerminal(terminal.id)?.agentCwd).toBe(context.worktreeRoot),
        );
        context.service.observeAgentCwd(agentCwdSignal(context, context.ownerRoot));

        await vi.waitFor(() =>
            expect(context.database.getTerminal(terminal.id)?.agentCwd).toBeUndefined(),
        );
        await context.service.close();
        context.database.close();
    });

    it('ignores a report whose provider no longer matches the Terminal', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/entered', rootPath: context.worktreeRoot },
        ]);
        const terminal = context.sessions[0].terminal!;

        context.service.observeAgentCwd({
            ...agentCwdSignal(context, context.worktreeRoot),
            provider: 'claude',
        });

        await vi.waitFor(() => expect(context.worktreeTopology).not.toHaveBeenCalled());
        expect(context.database.getTerminal(terminal.id)?.agentCwd).toBeUndefined();
        await context.service.close();
        context.database.close();
    });
});
