import type { ProjectStatusRepository } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { parseReviewFeedback, ReviewThreadStore } from '../review-threads';

const PR_URL = 'https://github.com/example/example/pull/7';
const CONTEXT = { owner: 'example', repo: 'example' };

function response(nodes: unknown[], comments?: unknown[]): string {
    return JSON.stringify({
        data: {
            repository: {
                pullRequest: {
                    reviewThreads: { nodes },
                    ...(comments && { comments: { nodes: comments } }),
                },
            },
        },
    });
}

/**
 * Codex's summary comment as it appears on GitHub, trimmed to the parts the parser reads.
 */
const CODEX_SUMMARY = [
    '<!-- codex-pull-request-review-summary -->',
    '',
    '## Codex Review Summary',
    '',
    '| Review | Status | Commit | Review trigger |',
    '| --- | --- | --- | --- |',
    '| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-12T18:47:57.170644Z">2026-10-12T18:47:57.170644Z</relative-time> | `9e912c5` | Manual request |',
    '| 🔒 **Security Review** | ⏳ **In progress** | `9e912c5` | Manual request |',
].join('\n');

function thread(overrides: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) {
    return {
        isResolved: false,
        isOutdated: false,
        path: 'src/app.ts',
        line: 12,
        comments: {
            nodes: [
                {
                    body: 'Rename this helper.',
                    url: `${PR_URL}#discussion_r1`,
                    createdAt: '2026-01-02T00:00:00Z',
                    author: { login: 'reviewer' },
                    ...comment,
                },
            ],
        },
        ...overrides,
    };
}

function pullRequest(
    lifecycle: 'open' | 'merged' = 'open',
): NonNullable<ProjectStatusRepository['pullRequest']> {
    return {
        number: 7,
        title: 'Feature',
        url: PR_URL,
        lifecycle,
        state: 'success',
        checks: [],
        hiddenCheckCount: 0,
    };
}

function createStore(runner: ExternalStatusRunner, now: () => number = () => 0) {
    const telemetry = {
        observe: vi.fn(({ run }: { run: () => Promise<string> }) => run()),
        recordParseFailure: vi.fn(),
    };
    return { store: new ReviewThreadStore(telemetry, runner, { now, ttlMs: 1_000 }), telemetry };
}

describe('parseReviewFeedback', () => {
    it('keeps only unresolved, current threads with a linkable opening comment', () => {
        const output = response([
            thread(),
            thread({ isResolved: true }),
            thread({ isOutdated: true }),
            thread({}, { url: null }),
            thread({ path: null, line: null }, { author: null, createdAt: null }),
            null,
        ]);
        expect(parseReviewFeedback(output).threads).toEqual([
            {
                url: `${PR_URL}#discussion_r1`,
                body: 'Rename this helper.',
                author: 'reviewer',
                createdAt: Date.UTC(2026, 0, 2),
                path: 'src/app.ts',
                line: 12,
            },
            { url: `${PR_URL}#discussion_r1`, body: 'Rename this helper.' },
        ]);
    });

    it('treats a pull request GitHub no longer returns as having no threads', () => {
        expect(parseReviewFeedback(JSON.stringify({ data: { repository: null } }))).toEqual({
            threads: [],
            threadCount: 0,
            codexReviews: [],
        });
    });

    it('counts resolved and outdated threads so a clean review reads as resolved', () => {
        const output = response([thread({ isResolved: true }), thread({ isOutdated: true })]);
        expect(parseReviewFeedback(output)).toMatchObject({ threads: [], threadCount: 2 });
    });

    it("reads Codex's review summary rows from the conversation", () => {
        const summaryUrl = `${PR_URL}#issuecomment-1`;
        const output = response(
            [],
            [
                { body: 'Deployed to preview.', url: `${PR_URL}#issuecomment-0` },
                { body: CODEX_SUMMARY, url: summaryUrl },
                null,
            ],
        );
        expect(parseReviewFeedback(output).codexReviews).toEqual([
            {
                name: 'Code Review',
                status: 'Completed',
                state: 'completed',
                commit: '9e912c5',
                trigger: 'Manual request',
                updatedAt: Date.parse('2026-10-12T18:47:57.170Z'),
                url: summaryUrl,
            },
            {
                name: 'Security Review',
                status: 'In progress',
                state: 'running',
                commit: '9e912c5',
                trigger: 'Manual request',
                url: summaryUrl,
            },
        ]);
    });
});

describe('ReviewThreadStore', () => {
    it('sends the pull request number as a typed GraphQL variable', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(response([thread()])));
        const { store } = createStore(runner);
        const attached = await store.attach('/project', CONTEXT, pullRequest(), false);
        expect(attached?.unresolvedReviewThreads).toHaveLength(1);
        const [command, arguments_] = runner.mock.calls[0];
        expect(command).toBe('gh');
        expect(arguments_.slice(0, 2)).toEqual(['api', 'graphql']);
        expect(arguments_[arguments_.indexOf('number=7') - 1]).toBe('--field');
    });

    it('skips a pull request that is no longer open', async () => {
        const runner = vi.fn<ExternalStatusRunner>();
        const { store } = createStore(runner);
        const merged = pullRequest('merged');
        expect(await store.attach('/project', CONTEXT, merged, false)).toBe(merged);
        expect(runner).not.toHaveBeenCalled();
    });

    it('reuses a fresh record, refetches after the TTL or on a forced read, and never caches a failure', async () => {
        let now = 0;
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(response([thread()])));
        const { store, telemetry } = createStore(runner, () => now);
        const attach = (isForced = false) =>
            store.attach('/project', CONTEXT, pullRequest(), isForced);

        await attach();
        await attach();
        expect(runner).toHaveBeenCalledOnce();

        await attach(true);
        expect(runner).toHaveBeenCalledTimes(2);

        now = 1_000;
        runner.mockResolvedValueOnce('{"data":{}}');
        // A malformed answer leaves the pull request undecorated and reaches the parse-failure telemetry.
        expect(await attach()).not.toHaveProperty('unresolvedReviewThreads');
        expect(telemetry.recordParseFailure).toHaveBeenCalledOnce();
        expect((await attach())?.unresolvedReviewThreads).toHaveLength(1);
        expect(runner).toHaveBeenCalledTimes(4);
    });
});
