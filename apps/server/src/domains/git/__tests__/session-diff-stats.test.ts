import type { GitRepositorySummary, GitSummary } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { SESSION_DIFF_STAT_TTL_MS, SessionDiffStatStore } from '../session-diff-stats';

const HEAD_OID = 'a'.repeat(40);
const MERGE_BASE_OID = 'b'.repeat(40);
const MOVED_OID = 'c'.repeat(40);

function repo(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
    return {
        id: 'repo',
        kind: 'primary',
        name: 'project',
        rootPath: '/workspace/project',
        branch: 'feat/rows',
        head: HEAD_OID,
        ahead: 0,
        behind: 0,
        additions: 0,
        deletions: 0,
        generation: 1,
        changedFileCount: 0,
        truncated: false,
        files: [],
        ...overrides,
    };
}

function summary(...repositories: GitRepositorySummary[]): GitSummary {
    return { isRepository: true, repositories };
}

interface FakeGitOptions {
    defaultReference?: string;
    /**
     * `undefined` makes `git diff` fail the way an oversized or broken diff does.
     */
    numstat?: string;
    untracked?: string[];
}

function fakeGit(options: FakeGitOptions = {}) {
    const calls: string[][] = [];
    const output = (arguments_: string[]): string => {
        if (arguments_[0] === 'symbolic-ref') return `${options.defaultReference ?? ''}\n`;
        if (arguments_[0] === 'merge-base') return `${MERGE_BASE_OID}\n`;
        if (arguments_[0] === 'diff' && options.numstat !== undefined) return options.numstat;
        if (arguments_[0] === 'ls-files')
            return (options.untracked ?? []).map((path) => `${path}\0`).join('');
        throw new Error(`unexpected git ${arguments_.join(' ')}`);
    };
    const git = (_cwd: string, arguments_: string[]): Promise<string> => {
        calls.push(arguments_);
        try {
            return Promise.resolve(output(arguments_));
        } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
    };
    return { calls, git };
}

describe('SessionDiffStatStore', () => {
    it('measures a feature branch from its fork point and adds untracked lines', async () => {
        const { calls, git } = fakeGit({
            defaultReference: 'origin/main',
            numstat: '10\t2\tsrc/a.ts\0-\t-\tlogo.png\0',
            untracked: ['new.ts', 'notes.md'],
        });
        const store = new SessionDiffStatStore({
            git,
            countUntrackedLines: (_root, path) => Promise.resolve(path === 'new.ts' ? 7 : 0),
        });

        const stat = await store.forSummary(summary(repo()));

        expect(stat).toEqual({ additions: 17, deletions: 2 });
        expect(calls).toContainEqual(['merge-base', 'HEAD', 'origin/main']);
        expect(calls).toContainEqual([
            'diff',
            '--numstat',
            '-z',
            '--no-renames',
            '--ignore-submodules=all',
            MERGE_BASE_OID,
            '--',
        ]);
    });

    it('measures only uncommitted work on the default branch itself', async () => {
        const { calls, git } = fakeGit({
            defaultReference: 'origin/main',
            numstat: '3\t1\ta.ts\0',
        });
        const store = new SessionDiffStatStore({
            git,
            countUntrackedLines: () => Promise.resolve(0),
        });

        const stat = await store.forSummary(summary(repo({ branch: 'main' })));

        expect(stat).toEqual({ additions: 3, deletions: 1 });
        expect(calls.some((call) => call[0] === 'merge-base')).toBe(false);
        expect(calls).toContainEqual([
            'diff',
            '--numstat',
            '-z',
            '--no-renames',
            '--ignore-submodules=all',
            'HEAD',
            '--',
        ]);
    });

    it('counts every file of an unborn repository as new', async () => {
        const { calls, git } = fakeGit({ untracked: ['a.ts', 'b.ts'] });
        const store = new SessionDiffStatStore({
            git,
            countUntrackedLines: () => Promise.resolve(4),
        });

        const stat = await store.forSummary(summary(repo({ head: undefined })));

        expect(stat).toEqual({ additions: 8, deletions: 0 });
        expect(calls).toEqual([
            ['ls-files', '-z', '--others', '--exclude-standard', '--cached', '--'],
        ]);
    });

    it('shares one measurement per root until the TTL passes, HEAD moves, or the status generation advances', async () => {
        const { calls, git } = fakeGit({ numstat: '1\t0\ta.ts\0' });
        let now = 0;
        const store = new SessionDiffStatStore({
            git,
            countUntrackedLines: () => Promise.resolve(0),
            now: () => now,
        });
        const diffCount = () => calls.filter((call) => call[0] === 'diff').length;
        const read = (overrides: Partial<GitRepositorySummary> = {}) =>
            store.forSummary(summary(repo(overrides)));

        await Promise.all([read(), read()]);
        expect(diffCount()).toBe(1);

        now = SESSION_DIFF_STAT_TTL_MS - 1;
        await read();
        expect(diffCount()).toBe(1);

        await read({ head: MOVED_OID });
        expect(diffCount()).toBe(2);

        await read({ head: MOVED_OID, generation: 2 });
        expect(diffCount()).toBe(3);

        now = 2 * SESSION_DIFF_STAT_TTL_MS;
        await read({ head: MOVED_OID, generation: 2 });
        expect(diffCount()).toBe(4);
    });

    it('measures a shared root once and leaves out a root whose diff fails', async () => {
        const healthy = fakeGit({ numstat: '2\t1\ta.ts\0' });
        const broken = fakeGit();
        const store = new SessionDiffStatStore({
            git: (cwd, arguments_) =>
                cwd === '/broken' ? broken.git(cwd, arguments_) : healthy.git(cwd, arguments_),
            countUntrackedLines: () => Promise.resolve(0),
        });
        const summarized: string[] = [];

        const stats = await store.forSessions(
            [
                { id: 'first', rootPath: '/workspace/project' },
                { id: 'second', rootPath: '/workspace/project' },
                { id: 'third', rootPath: '/broken' },
            ],
            (sessionId) => {
                summarized.push(sessionId);
                return Promise.resolve(
                    summary(repo(sessionId === 'third' ? { rootPath: '/broken' } : {})),
                );
            },
        );

        expect(stats).toEqual({
            stats: {
                first: { additions: 2, deletions: 1 },
                second: { additions: 2, deletions: 1 },
            },
        });
        expect(summarized).toEqual(['first', 'third']);
    });

    it('reports nothing for a root that is not a repository', async () => {
        const { git } = fakeGit();
        const store = new SessionDiffStatStore({ git });

        expect(
            await store.forSummary({
                isRepository: false,
                repositories: [],
            }),
        ).toBeUndefined();
    });
});
