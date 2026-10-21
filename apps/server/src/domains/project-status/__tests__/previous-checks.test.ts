import type { ProjectStatusRepository } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { PreviousChecksStore, selectPreviousChecks } from '../previous-checks';

const PR_URL = 'https://github.com/example/example/pull/7';
const CONTEXT = { owner: 'example', repo: 'example' };
const HEAD = 'c'.repeat(40);

type Context = Record<string, unknown>;

const run = (name: string, conclusion: string | null, status = 'COMPLETED'): Context => ({
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
});

function commit(oid: string, title: string, contexts: Context[] | null) {
    return {
        commit: {
            oid,
            messageHeadline: title,
            statusCheckRollup: contexts ? { contexts: { nodes: contexts } } : null,
        },
    };
}

function response(commits: unknown[]): string {
    return JSON.stringify({
        data: { repository: { pullRequest: { commits: { nodes: commits } } } },
    });
}

function pullRequest(
    overrides: Partial<NonNullable<ProjectStatusRepository['pullRequest']>> = {},
): NonNullable<ProjectStatusRepository['pullRequest']> {
    return {
        number: 7,
        title: 'Feature',
        url: PR_URL,
        lifecycle: 'open',
        state: 'pending',
        checks: [],
        hiddenCheckCount: 0,
        headSha: HEAD,
        ...overrides,
    };
}

describe('selectPreviousChecks', () => {
    it('picks the newest earlier commit whose checks settled, skipping cancelled and check-less ones', () => {
        const output = response([
            commit('a'.repeat(40), 'feat: first', [run('test', 'FAILURE')]),
            commit('b'.repeat(40), 'fix: handle empty input', [run('test', 'SUCCESS')]),
            commit('d'.repeat(40), 'chore: intermediate', null),
            commit('e'.repeat(40), 'fix: superseded', [run('test', 'CANCELLED')]),
            commit(HEAD, 'docs: typo', [run('test', null, 'IN_PROGRESS')]),
        ]);

        expect(selectPreviousChecks(output, HEAD, [])).toEqual({
            selection: {
                oid: 'b'.repeat(40),
                title: 'fix: handle empty input',
                state: 'success',
                commitsBefore: 3,
            },
            isSettled: true,
        });
    });

    it('marks the answer unsettled when it skipped a commit still running', () => {
        const output = response([
            commit('a'.repeat(40), 'feat: first', [run('test', 'FAILURE')]),
            commit('b'.repeat(40), 'fix: second', [run('test', null, 'QUEUED')]),
            commit(HEAD, 'docs: typo', []),
        ]);

        const result = selectPreviousChecks(output, HEAD, []);
        expect(result.selection).toMatchObject({ state: 'failure', commitsBefore: 2 });
        expect(result.isSettled).toBe(false);
    });

    it('judges a commit by the checks left after projectStatus.ignoredChecks', () => {
        const output = response([
            commit('a'.repeat(40), 'feat: first', [
                run('test', 'SUCCESS'),
                run('flaky-preview', 'FAILURE'),
            ]),
            commit(HEAD, 'docs: typo', []),
        ]);

        expect(selectPreviousChecks(output, HEAD, ['flaky-preview']).selection?.state).toBe(
            'success',
        );
        expect(selectPreviousChecks(output, HEAD, []).selection?.state).toBe('failure');
    });

    it('settles a commit as failed while its other checks still run, and as passed when every check was skipped', () => {
        const output = response([
            commit('a'.repeat(40), 'feat: first', [
                run('test', 'FAILURE'),
                run('e2e', null, 'IN_PROGRESS'),
            ]),
            commit('b'.repeat(40), 'feat: second', [
                run('test', 'SKIPPED'),
                run('lint', 'NEUTRAL'),
            ]),
            commit(HEAD, 'docs: typo', []),
        ]);

        expect(selectPreviousChecks(output, HEAD, []).selection).toMatchObject({
            title: 'feat: second',
            state: 'success',
            commitsBefore: 1,
        });
        const withoutSecond = response([
            commit('a'.repeat(40), 'feat: first', [
                run('test', 'FAILURE'),
                run('e2e', null, 'IN_PROGRESS'),
            ]),
            commit(HEAD, 'docs: typo', []),
        ]);
        const settledFailure = selectPreviousChecks(withoutSecond, HEAD, []);
        expect(settledFailure.selection).toMatchObject({ state: 'failure', commitsBefore: 1 });
        expect(settledFailure.isSettled).toBe(true);
    });

    it('returns nothing when the commit list no longer ends at the reported head', () => {
        const output = response([commit('a'.repeat(40), 'feat: first', [run('test', 'SUCCESS')])]);

        expect(selectPreviousChecks(output, HEAD, [])).toEqual({ isSettled: false });
    });
});

describe('PreviousChecksStore', () => {
    function createStore(runner: ExternalStatusRunner, now: () => number = () => 0) {
        const telemetry = {
            observe: vi.fn(({ run: execute }: { run: () => Promise<string> }) => execute()),
            recordParseFailure: vi.fn(),
        };
        return { store: new PreviousChecksStore(telemetry, runner, { now }), telemetry };
    }

    const commits = response([
        commit('b'.repeat(40), 'fix: handle empty input', [run('test', 'SUCCESS')]),
        commit(HEAD, 'docs: typo', []),
    ]);
    const files = JSON.stringify([{ path: 'docs/guide.md', additions: 2, deletions: 1 }]);

    function fakeRunner(): ExternalStatusRunner & ReturnType<typeof vi.fn> {
        return vi.fn((_command: string, arguments_: readonly string[]) =>
            Promise.resolve(arguments_.includes('graphql') ? commits : files),
        );
    }

    it('attaches the previous verdict and the files changed since it', async () => {
        const runner = fakeRunner();
        const { store } = createStore(runner);

        const result = await store.attach('/repo', CONTEXT, pullRequest(), [], false);

        expect(result?.previousChecks).toEqual({
            title: 'fix: handle empty input',
            state: 'success',
            commitsBefore: 1,
            url: `${PR_URL}/commits/${'b'.repeat(40)}`,
            changedFiles: [{ path: 'docs/guide.md', additions: 2, deletions: 1 }],
        });
        expect(runner.mock.calls[1]?.[1]).toContain(
            `repos/example/example/compare/${'b'.repeat(40)}...${HEAD}`,
        );
    });

    it('keeps a settled answer for ten minutes instead of asking GitHub on every poll', async () => {
        let now = 0;
        const runner = fakeRunner();
        const { store } = createStore(runner, () => now);

        await store.attach('/repo', CONTEXT, pullRequest(), [], false);
        now = 9 * 60_000;
        await store.attach('/repo', CONTEXT, pullRequest(), [], false);
        expect(runner).toHaveBeenCalledTimes(2);

        now = 11 * 60_000;
        await store.attach('/repo', CONTEXT, pullRequest(), [], false);
        expect(runner).toHaveBeenCalledTimes(4);
    });

    it('spends nothing on a green, merged, or hash-less pull request', async () => {
        const runner = fakeRunner();
        const { store } = createStore(runner);

        const skipped = [
            pullRequest({ state: 'success' }),
            pullRequest({ lifecycle: 'merged' }),
            pullRequest({ headSha: undefined }),
        ];
        const results = await Promise.all(
            skipped.map((pr) => store.attach('/repo', CONTEXT, pr, [], false)),
        );

        expect(results).toEqual(skipped);
        expect(runner).not.toHaveBeenCalled();
    });

    it('keeps the verdict when the comparison fails and returns the pull request unchanged on a failed query', async () => {
        const compareFails = vi.fn((_command: string, arguments_: readonly string[]) =>
            arguments_.includes('graphql')
                ? Promise.resolve(commits)
                : Promise.reject(new Error('compare failed')),
        );
        const { store, telemetry } = createStore(compareFails);
        const result = await store.attach('/repo', CONTEXT, pullRequest(), [], false);
        expect(result?.previousChecks).toMatchObject({ state: 'success' });
        expect(result?.previousChecks?.changedFiles).toBeUndefined();
        expect(telemetry.recordParseFailure).toHaveBeenCalledTimes(1);

        const failing = createStore(vi.fn(() => Promise.reject(new Error('graphql failed'))));
        const pr = pullRequest();
        expect(await failing.store.attach('/repo', CONTEXT, pr, [], false)).toBe(pr);
    });
});
