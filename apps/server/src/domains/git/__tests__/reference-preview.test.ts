import type { GitCommitDetails, TerminalReferenceContext } from '@caxri/protocol';
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
    const context: TerminalReferenceContext = {
        githubRepositories: [{ owner: 'tjx666', repo: 'caxri' }],
    };
    return {
        commitDetails: () => Promise.resolve(COMMIT_DETAILS),
        githubReferences: {} as GitHubReferenceStore,
        logger: LOGGER,
        referenceContext: () => Promise.resolve(context),
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

    it('never spends a request on a repository the Session does not already have', async () => {
        const runner = vi.fn(() => Promise.resolve('{}'));
        const options = createOptions({ githubReferences: new ReferenceStore(runner) });
        // A Terminal prints whatever a program writes, so `attacker/repo#1` scrolling past the pointer must not be
        // able to steer an outbound read at a repository of its choosing.
        const preview = await loadTerminalReferencePreview(
            { kind: 'github', owner: 'attacker', repo: 'repo', number: 1 },
            options,
        );

        expect(preview).toEqual({ kind: 'unavailable', reason: 'not-found' });
        expect(runner).not.toHaveBeenCalled();
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
            ['api', 'repos/tjx666/caxri/issues/445'],
            '/project',
        );
    });
});
