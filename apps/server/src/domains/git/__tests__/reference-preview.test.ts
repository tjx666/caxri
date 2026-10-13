import type { GitCommitDetails } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { GitHubReferenceStore } from '../../external-status';
import { GitHubReferenceStore as ReferenceStore } from '../../external-status';
import { ExternalStatusCliError } from '../../external-status/command';
import type { TerminalReferencePreviewOptions } from '../reference-preview';
import { loadTerminalReferencePreview } from '../reference-preview';

const SHA = 'f36a02ac'.padEnd(40, '0');

const COMMIT_DETAILS = {
    additions: 12,
    commit: {
        author: 'Ada Lovelace',
        authoredAt: 1_700_000_000_000,
        body: 'Explains why.',
        sha: SHA,
        shortSha: 'f36a02a',
        subject: 'Serialize Session-state writes',
    },
    deletions: 4,
    files: [{ path: 'a.ts' }, { path: 'b.ts' }],
} as unknown as GitCommitDetails;

const LOGGER = { write: vi.fn() } as unknown as TerminalReferencePreviewOptions['logger'];

function createOptions(
    overrides: Partial<TerminalReferencePreviewOptions> = {},
): TerminalReferencePreviewOptions {
    return {
        commitDetails: () => Promise.resolve(COMMIT_DETAILS),
        githubReferences: {} as GitHubReferenceStore,
        logger: LOGGER,
        resolveCommit: () =>
            Promise.resolve({
                status: 'resolved',
                candidate: { repositoryId: 'repo-1', repositoryName: 'caxri', sha: SHA },
            }),
        schedule: (work) => work(),
        terminalCwd: '/project',
        ...overrides,
    };
}

describe('loadTerminalReferencePreview', () => {
    it('projects a resolved commit onto the card the Renderer renders', async () => {
        expect(
            await loadTerminalReferencePreview(
                { kind: 'commit', reference: 'f36a02a' },
                createOptions(),
            ),
        ).toEqual({
            kind: 'commit',
            author: 'Ada Lovelace',
            authoredAt: 1_700_000_000_000,
            body: 'Explains why.',
            changedFileCount: 2,
            deletions: 4,
            insertions: 12,
            repositoryName: 'caxri',
            sha: SHA,
            shortSha: 'f36a02a',
            subject: 'Serialize Session-state writes',
        });
    });

    it('says an abbreviation matching two repositories is ambiguous instead of picking one', async () => {
        expect(
            await loadTerminalReferencePreview(
                { kind: 'commit', reference: 'f36a02a' },
                createOptions({
                    resolveCommit: () =>
                        Promise.resolve({
                            status: 'ambiguous',
                            candidates: [
                                { repositoryId: 'repo-1', repositoryName: 'caxri', sha: SHA },
                                { repositoryId: 'repo-2', repositoryName: 'other', sha: SHA },
                            ],
                        }),
                }),
            ),
        ).toEqual({ kind: 'unavailable', reason: 'ambiguous' });
    });

    it('reads a pull request in a repository the Session does not have', async () => {
        const runner = vi.fn(() =>
            Promise.resolve(
                JSON.stringify({
                    number: 42,
                    pull_request: { merged_at: '2026-09-02T00:00:00Z' },
                    state: 'closed',
                    title: 'Use the shared icon set',
                }),
            ),
        );
        // The Session's own repository is `tjx666/caxri`; an Agent linking a pull request it opened in a sibling
        // repository still needs that pull request's state, or a merged one keeps reading as open.
        const preview = await loadTerminalReferencePreview(
            { kind: 'github', owner: 'acme', repo: 'widgets', number: 42 },
            createOptions({ githubReferences: new ReferenceStore(runner) }),
        );

        expect(preview).toMatchObject({ kind: 'github', isMerged: true, isPullRequest: true });
        expect(runner).toHaveBeenCalledWith(
            'gh',
            ['api', '--hostname', 'github.com', 'repos/acme/widgets/issues/42'],
            '/project',
        );
    });

    it.each([
        ['not-found' as const, 'cli-missing'],
        ['not-logged-in' as const, 'not-authenticated'],
        ['rate-limited' as const, 'rate-limited'],
        ['timeout' as const, 'failed'],
    ])(
        'degrades a %s failure to a reason the operator can act on rather than rejecting',
        async (kind, reason) => {
            const failure = new ExternalStatusCliError('gh', kind, 'gh could not answer');
            const options = createOptions({
                githubReferences: {
                    view: () => Promise.reject(failure),
                } as unknown as GitHubReferenceStore,
            });

            const preview = await loadTerminalReferencePreview(
                { kind: 'github', owner: 'tjx666', repo: 'caxri', number: 445 },
                options,
            );

            expect(preview).toEqual({ kind: 'unavailable', reason });
        },
    );

    it('reads a known repository through the GitHub CLI with a structured argument array', async () => {
        const runner = vi.fn(() =>
            Promise.resolve(
                JSON.stringify({
                    created_at: '2026-09-01T00:00:00Z',
                    html_url: 'https://github.com/tjx666/caxri/pull/445',
                    number: 445,
                    pull_request: { merged_at: '2026-09-02T00:00:00Z' },
                    state: 'closed',
                    title: 'Hover preview for Terminal references',
                    user: { login: 'tjx666' },
                }),
            ),
        );

        const options = createOptions({ githubReferences: new ReferenceStore(runner) });
        const preview = await loadTerminalReferencePreview(
            { kind: 'github', owner: 'tjx666', repo: 'caxri', number: 445 },
            options,
        );

        expect(preview).toMatchObject({
            kind: 'github',
            author: 'tjx666',
            isDraft: false,
            isMerged: true,
            isPullRequest: true,
            number: 445,
            state: 'closed',
            title: 'Hover preview for Terminal references',
        });
        expect(runner).toHaveBeenCalledWith(
            'gh',
            ['api', '--hostname', 'github.com', 'repos/tjx666/caxri/issues/445'],
            '/project',
        );
    });
});
