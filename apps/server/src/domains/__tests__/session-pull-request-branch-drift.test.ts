import { describe, expect, it, vi } from 'vitest';

import { createdPullRequestLines, harness, pullRequestJson } from './session-pull-requests.fixture';

const TRANSCRIPT_PULL_REQUEST = 'https://github.com/example/example/pull/19024';

/**
 * Answers `gh` for a Session whose transcript created pull request 19024 and whose branch now carries `branchNumber`.
 * Passing `undefined` means the branch has no pull request at all.
 */
function githubWithBranch(
    branchNumber: number | undefined,
    transcriptState = 'MERGED',
): ReturnType<typeof vi.fn<(arguments_: readonly string[]) => Promise<string>>> {
    return vi.fn((arguments_: readonly string[]) => {
        if (arguments_[1] === 'list')
            return Promise.resolve(
                branchNumber === undefined
                    ? '[]'
                    : `[${pullRequestJson({ number: branchNumber, state: 'OPEN' })}]`,
            );
        if (arguments_[2] === '19024')
            return Promise.resolve(pullRequestJson({ state: transcriptState }));
        return Promise.resolve(
            pullRequestJson({
                number: Number(arguments_[2]),
                state: 'OPEN',
                title: 'fix: the next delivery',
                url: `https://github.com/example/example/pull/${arguments_[2]}`,
                statusCheckRollup: [],
            }),
        );
    });
}

/**
 * Issue #1035: the transcript scan only advances on a `gh pr create` run inside that one transcript, so a Session that
 * moved on (next pull request opened from another conversation, or simply a new branch) kept showing the delivery that
 * already landed, contradicting the status bar that has always queried by branch.
 */
describe('session pull request branch drift', () => {
    it('hands the row to the branch pull request once the transcript one has merged', async () => {
        const gh = githubWithBranch(21000);
        const { service, setTranscript } = await harness({ gh });
        await setTranscript(createdPullRequestLines);

        await service.refresh();

        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 21000,
            state: 'open',
            url: 'https://github.com/example/example/pull/21000',
            source: 'branch',
        });
    });

    it('keeps a just-merged pull request when the branch has none yet, instead of blanking the row', async () => {
        const gh = githubWithBranch(undefined);
        const { service, setTranscript } = await harness({ gh });
        await setTranscript(createdPullRequestLines);

        await service.refresh();

        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 19024,
            state: 'merged',
            source: 'agent',
        });
    });

    it('keeps the transcript projection when the branch reports the same pull request', async () => {
        const gh = githubWithBranch(19024);
        const { service, setTranscript } = await harness({ gh });
        await setTranscript(createdPullRequestLines);

        await service.refresh();

        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 19024,
            source: 'agent',
        });
    });

    it('spends no branch query while the transcript pull request is still open', async () => {
        const gh = githubWithBranch(21000, 'OPEN');
        const { service, setTranscript } = await harness({ gh });
        await setTranscript(createdPullRequestLines);

        await service.refresh();

        expect(gh.mock.calls.every(([arguments_]) => arguments_[1] === 'view')).toBe(true);
        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 19024,
            state: 'open',
            source: 'agent',
        });
    });

    /**
     * A settled pull request is re-confirmed only every fifteen minutes, which is exactly what let the stale row
     * survive. The branch hand-off must therefore shorten the Session entry's own lifetime, or the next sweep would
     * skip the branch entirely and the row would take a quarter of an hour to notice its successor.
     */
    it('re-checks the branch on the next sweep instead of waiting out the settled TTL', async () => {
        let now = 0;
        const gh = githubWithBranch(undefined);
        const { service, setTranscript } = await harness({ gh, now: () => now });
        await setTranscript(createdPullRequestLines);
        await service.refresh();
        const afterFirstSweep = gh.mock.calls.length;

        now += 6 * 60_000;
        await service.refresh();

        expect(gh.mock.calls.length).toBeGreaterThan(afterFirstSweep);
        expect(service.snapshot().pullRequests['session-1']).toMatchObject({ number: 19024 });
    });

    it('ignores a failed branch lookup rather than badging a good projection as unavailable', async () => {
        const gh = vi.fn((arguments_: readonly string[]) =>
            arguments_[1] === 'list'
                ? Promise.reject(new Error('gh: could not connect to github.com'))
                : Promise.resolve(pullRequestJson()),
        );
        const { service, setTranscript } = await harness({ gh });
        await setTranscript(createdPullRequestLines);

        await service.refresh();

        const snapshot = service.snapshot();
        expect(snapshot.pullRequests['session-1']).toMatchObject({
            number: 19024,
            url: TRANSCRIPT_PULL_REQUEST,
            source: 'agent',
        });
        expect(snapshot.unavailable?.['session-1']).toBeUndefined();
    });
});
