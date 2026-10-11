import { describe, expect, it, vi } from 'vitest';

import type { GitWorktreeTopology } from '../../git/index';
import { beginWorktreeCreation, fixture, shellFinished, shellStarted } from './roots.fixture';

describe('WorkbenchRootService manual Agent launch attribution', () => {
    it('does not capture a before-snapshot after manual priming exceeds the hook budget', async () => {
        const context = await fixture();
        const pending = Promise.withResolvers<GitWorktreeTopology>();
        context.worktreeTopology.mockImplementationOnce(() => pending.promise);
        vi.useFakeTimers();
        try {
            const started = context.service.observeShellToolStarted(
                shellStarted(context, { worktreeCreateIntent: true }),
                () => true,
            );
            await vi.advanceTimersByTimeAsync(1_500);
            await expect(started).resolves.toBe('accepted');
            pending.resolve(context.getTopology());
            await vi.advanceTimersByTimeAsync(0);
            expect(context.worktreeTopology).toHaveBeenCalledTimes(1);
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            );
            await vi.advanceTimersByTimeAsync(100);
            expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual(
                [],
            );
        } finally {
            vi.useRealTimers();
            await context.service.close();
            context.database.close();
        }
    });

    it('does not read Git or create a candidate for an unprimed stale launch', async () => {
        const context = await fixture();
        await expect(
            context.service.observeShellToolStarted(
                shellStarted(context, { worktreeCreateIntent: true }),
                () => false,
            ),
        ).resolves.toBe('staleLaunch');
        expect(context.worktreeTopology).not.toHaveBeenCalled();
        expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual([]);
        await context.service.close();
        context.database.close();
    });
    it('attributes creation after manual resume restores Shell hook authority', async () => {
        const context = await fixture();
        // Manual resume inherits Shell hooks without the managed launch priming callback.
        await beginWorktreeCreation(context);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/manual-resume', rootPath: context.worktreeRoot },
        ]);
        context.service.observeShellToolFinished(
            shellFinished(context, { worktreeCreateIntent: true }),
        );
        await vi.waitFor(() =>
            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1),
        );
        await context.service.close();
        context.database.close();
    });

    it.each(['priming', 'capture', 'outcome'] as const)(
        'fences a manual launch retired during %s',
        async (stage) => {
            const context = await fixture();
            let isCurrent = true;
            const pending = Promise.withResolvers<GitWorktreeTopology>();
            if (stage === 'priming')
                context.worktreeTopology.mockImplementationOnce(() => pending.promise);
            else if (stage === 'capture') {
                context.worktreeTopology.mockResolvedValueOnce(context.getTopology());
                context.worktreeTopology.mockImplementationOnce(() => pending.promise);
            }
            const started = context.service.observeShellToolStarted(
                shellStarted(context, { worktreeCreateIntent: true }),
                () => isCurrent,
            );
            if (stage === 'outcome') await started;
            else
                await vi.waitFor(() =>
                    expect(context.worktreeTopology).toHaveBeenCalledTimes(
                        stage === 'priming' ? 1 : 2,
                    ),
                );
            isCurrent = false;
            pending.resolve(context.getTopology());
            await started;
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature/late', rootPath: context.worktreeRoot },
            ]);
            context.service.observeShellToolFinished(
                shellFinished(context, { worktreeCreateIntent: true }),
            );
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual(
                [],
            );
            await context.service.close();
            context.database.close();
        },
    );
});
