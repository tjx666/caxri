import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { agentCwdSignal, fixture } from './workbench-roots.fixture';

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

    it('discards a reported directory that Git topology does not list as a worktree root', async () => {
        const context = await fixture();
        const nested = join(context.ownerRoot, 'packages');
        await mkdir(nested);
        const terminal = context.sessions[0].terminal!;

        context.service.observeAgentCwd(agentCwdSignal(context, nested));
        context.service.observeAgentCwd(agentCwdSignal(context, context.worktreeRoot));

        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(2));
        expect(context.database.getTerminal(terminal.id)?.agentCwd).toBeUndefined();
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });

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
