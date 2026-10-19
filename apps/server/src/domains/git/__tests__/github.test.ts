import type { GitRepositorySummary } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { GitHubPullRequestStore } from '../../external-status';
import { ExternalStatusCliError } from '../../external-status';
import { readGitHubPullRequestView } from '../github';

const repo = { branch: 'feat/x', rootPath: '/repo' } as GitRepositorySummary;

function read(error: unknown) {
    return readGitHubPullRequestView(repo, {
        github: { view: vi.fn().mockRejectedValue(error) } as unknown as GitHubPullRequestStore,
        logger: { write: vi.fn() } as never,
        // eslint-disable-next-line promise/no-promise-in-callback -- a resolved stub, not a callback chain
        originRemote: () => Promise.resolve('https://github.com/o/r.git'),
        schedule: (work) => work(),
    });
}

describe('readGitHubPullRequestView failures', () => {
    it.each(['not-found', 'not-logged-in', 'rate-limited'] as const)(
        'maps %s to the caller-handled UNAVAILABLE code',
        async (kind) => {
            await expect(
                read(new ExternalStatusCliError('gh', kind, 'x', 4)),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        },
    );

    it('keeps unexpected gh failures as GIT', async () => {
        await expect(read(new ExternalStatusCliError('gh', 'other', 'x', 1))).rejects.toMatchObject(
            { code: 'GIT' },
        );
    });
});
