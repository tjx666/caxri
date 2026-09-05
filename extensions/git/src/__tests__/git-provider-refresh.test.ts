import { CancellationTokenSource } from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import { createHarness, scopeId } from './git-provider.fixture';

describe('GitProvider refresh nonce', () => {
    /**
     * Regression for #584: every `onDidChangeGit`/active-context refresh used to reach Host as a new forcing nonce, so
     * each watcher event ran a forced full re-discovery in parallel with the Renderer's plain read.
     */
    it('forces a Host refresh only after an action asks for one, never on watcher-driven re-reads', async () => {
        const { git, provider } = createHarness();
        const cancellation = new CancellationTokenSource();

        await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        provider.refresh(scopeId);
        await provider.provideView({ scopeId, refresh: 1 }, cancellation.token);
        provider.refresh();
        const view = await provider.provideView({ scopeId, refresh: 2 }, cancellation.token);
        expect(git.summary.mock.calls.map(([refresh]) => refresh)).toEqual([0, 0, 0]);

        const result = await provider.runAction(
            { actionId: view.refreshAction.id, scopeId, revision: view.revision },
            cancellation.token,
        );
        expect(result.refresh).toBe(true);
        await provider.provideView({ scopeId, refresh: 3 }, cancellation.token);
        const forcedNonce = git.summary.mock.calls.at(-1)![0] ?? 0;
        expect(forcedNonce).toBeGreaterThan(0);

        // A later watcher re-read keeps the same nonce, so Host treats it as a plain read again.
        provider.refresh(scopeId);
        await provider.provideView({ scopeId, refresh: 4 }, cancellation.token);
        expect(git.summary.mock.calls.at(-1)![0]).toBe(forcedNonce);

        // The command palette and Renderer command paths force exactly like the panel action does.
        await provider.executeCommand('caxri.git.refresh', [], cancellation.token);
        await provider.provideView({ scopeId, refresh: 5 }, cancellation.token);
        const commandNonce = git.summary.mock.calls.at(-1)![0] ?? 0;
        expect(commandNonce).toBeGreaterThan(forcedNonce);
        provider.forceRefresh(scopeId);
        await provider.provideView({ scopeId, refresh: 6 }, cancellation.token);
        expect(git.summary.mock.calls.at(-1)![0]).toBeGreaterThan(commandNonce);

        cancellation.dispose();
        provider.dispose();
    });

    it('sends the Pull Request detail the same forcing nonce as the summary, not the Renderer counter', async () => {
        const { git, provider } = createHarness();
        const cancellation = new CancellationTokenSource();

        await provider.provideView(
            { scopeId, preferredModeId: 'pull-request', refresh: 7 },
            cancellation.token,
        );
        await vi.waitFor(() => expect(git.pullRequestChanges).toHaveBeenCalled());
        expect(git.pullRequestChanges.mock.calls.at(-1)![1]).toBe(0);

        cancellation.dispose();
        provider.dispose();
    });
});
