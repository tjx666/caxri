import { CancellationTokenSource } from 'caxri';
import { describe, expect, it } from 'vitest';

import { createHarness, scopeId, summary } from './git-provider.fixture';

describe('GitProvider diff exclusions', () => {
    it('blocks bulk discard when truncation can hide excluded paths outside the loaded list', async () => {
        const { git, provider } = createHarness({ diffExclude: { '**/*.test.*': true } });
        git.summary.mockResolvedValue({
            ...summary,
            repositories: [
                { ...summary.repositories[0], changedFileCount: 2_001, truncated: true },
            ],
        });
        const cancellation = new CancellationTokenSource();
        try {
            const hidden = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
            const group = hidden.providers[0].groups[0];
            expect(group.hiddenCount).toBeUndefined();
            await expect(
                provider.runAction(
                    { actionId: group.actions[0].id, revision: hidden.revision, scopeId },
                    cancellation.token,
                ),
            ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
            expect(group.actions[0].disabled).toBe(true);
            expect(git.discard).not.toHaveBeenCalled();

            await provider.runAction(
                { actionId: hidden.headerActions![0].id, revision: hidden.revision, scopeId },
                cancellation.token,
            );
            const shown = await provider.provideView({ scopeId, refresh: 1 }, cancellation.token);
            expect(shown.providers[0].groups[0].actions[0].disabled).toBe(false);
        } finally {
            cancellation.dispose();
            provider.dispose();
        }
    });

    it('reads configured patterns and keeps the show-excluded toggle scoped to the view', async () => {
        const { git, provider } = createHarness({ diffExclude: { '**/*.test.*': true } });
        git.summary.mockResolvedValue({
            ...summary,
            repositories: [
                {
                    ...summary.repositories[0],
                    changedFileCount: 2,
                    files: [
                        ...summary.repositories[0].files,
                        {
                            path: 'src/extension.test.ts',
                            index: ' ',
                            workingTree: 'M',
                            kind: 'modified',
                        },
                    ],
                },
            ],
        });
        const cancellation = new CancellationTokenSource();

        const hidden = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        expect(hidden.providers[0].groups[0]).toMatchObject({
            count: 2,
            hiddenCount: 1,
            resources: [{ label: 'extension.ts' }],
        });
        expect(hidden.headerActions?.[0]).toMatchObject({
            label: 'Show excluded files (1)',
            pressed: false,
        });
        await expect(
            provider.runAction(
                {
                    actionId: hidden.providers[0].groups[0].actions[0].id,
                    revision: hidden.revision,
                    scopeId,
                },
                cancellation.token,
            ),
        ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
        expect(git.discard).not.toHaveBeenCalled();

        const toggled = await provider.runAction(
            {
                actionId: hidden.headerActions![0].id,
                revision: hidden.revision,
                scopeId,
            },
            cancellation.token,
        );
        expect(toggled).toMatchObject({ refresh: true });

        const shown = await provider.provideView({ scopeId, refresh: 1 }, cancellation.token);
        expect(shown.providers[0].groups[0].resources).toHaveLength(2);
        expect(shown.providers[0].groups[0].hiddenCount).toBeUndefined();
        expect(shown.headerActions?.[0]).toMatchObject({
            label: 'Hide excluded files (1)',
            pressed: true,
        });
        expect(shown.providers[0].groups[0].actions[0]).toMatchObject({ disabled: false });
        await provider.runAction(
            {
                actionId: shown.providers[0].groups[0].actions[0].id,
                revision: shown.revision,
                scopeId,
            },
            cancellation.token,
        );
        expect(git.discard).toHaveBeenCalledOnce();

        const otherScope = await provider.provideView(
            { scopeId: 'session-b:project-a', refresh: 0 },
            cancellation.token,
        );
        expect(otherScope.headerActions?.[0]).toMatchObject({
            label: 'Show excluded files (1)',
            pressed: false,
        });
        expect(otherScope.providers[0].groups[0]).toMatchObject({ hiddenCount: 1 });

        cancellation.dispose();
        provider.dispose();
    });
});
