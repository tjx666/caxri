import { describe, expect, it, vi } from 'vitest';

import { OriginRemoteFacts } from '../origin-remote-facts';

const isRootPresent = () => Promise.resolve(true);

describe('OriginRemoteFacts', () => {
    it('keeps the cached key until revalidated, then follows a changed origin', async () => {
        let remote = 'https://github.com/someone/caxri.git';
        const emit = vi.fn();
        const facts = new OriginRemoteFacts(() => Promise.resolve(remote), emit, isRootPresent);
        const before = await facts.repositoryKey('/work/caxri');
        remote = 'https://github.com/tjx666/caxri.git';
        expect(await facts.repositoryKey('/work/caxri')).toBe(before);

        await facts.revalidate();
        expect(emit).toHaveBeenCalledWith({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.repositoryKeys' },
        });
        const after = await facts.repositoryKey('/work/caxri');
        expect(after).not.toBe(before);
        expect(after).toContain('tjx666/caxri');
    });

    it('reports no change when origin is untouched, and refreshes the cached host', async () => {
        let remote = 'git@github.com:tjx666/caxri.git';
        const emit = vi.fn();
        const facts = new OriginRemoteFacts(() => Promise.resolve(remote), emit, isRootPresent);
        await facts.repositoryKey('/work/caxri');
        expect(await facts.host('/work/caxri')).toBe('github.com');
        await facts.revalidate();
        expect(emit).not.toHaveBeenCalled();

        remote = 'git@git.example.com:tjx666/caxri.git';
        await facts.revalidate();
        expect(await facts.host('/work/caxri')).toBe('git.example.com');
    });

    it('answers host, key, and GitHub repository from one read per root until revalidated', async () => {
        let remote = 'git@github.com:tjx666/caxri.git\n';
        const originRemote = vi.fn(() => Promise.resolve(remote));
        const facts = new OriginRemoteFacts(originRemote, undefined, isRootPresent);
        const [repo] = await Promise.all([
            facts.githubRepository('/work/caxri'),
            facts.githubRepository('/work/caxri'),
            facts.host('/work/caxri'),
        ]);
        expect(repo).toEqual({ owner: 'tjx666', repo: 'caxri' });
        expect(await facts.repositoryKey('/work/caxri')).toContain('tjx666/caxri');
        expect(originRemote).toHaveBeenCalledTimes(1);

        remote = 'git@git.example.com:tjx666/caxri.git';
        await facts.revalidate();
        expect(await facts.githubRepository('/work/caxri')).toBeUndefined();
        expect(originRemote).toHaveBeenCalledTimes(2);
    });

    it('treats a root that lost its origin as changed to null', async () => {
        let remote = 'git@github.com:tjx666/caxri.git';
        const emit = vi.fn();
        const facts = new OriginRemoteFacts(() => Promise.resolve(remote), emit, isRootPresent);
        await facts.repositoryKey('/work/caxri');
        remote = '';
        await facts.revalidate();
        expect(emit).toHaveBeenCalledWith({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.repositoryKeys' },
        });
        expect(await facts.repositoryKey('/work/caxri')).toBeNull();
    });

    it('re-reads only the changed repository, once for all of its worktrees', async () => {
        const remote = 'git@github.com:tjx666/caxri.git';
        const originRemote = vi.fn((root: string) =>
            Promise.resolve(root.startsWith('/other') ? 'git@github.com:x/y.git' : remote),
        );
        const groups = new Map([
            ['/work/caxri', '/work/caxri/.git'],
            ['/work/caxri-a', '/work/caxri/.git'],
            ['/work/caxri-b', '/work/caxri/.git'],
            ['/other/repo', '/other/repo/.git'],
        ]);
        const topology = { repositoryKeyForRoot: (root: string) => groups.get(root) };
        const facts = new OriginRemoteFacts(originRemote, undefined, isRootPresent);
        await Promise.all([...groups.keys(), '/unknown/root'].map((root) => facts.host(root)));
        originRemote.mockClear();

        await facts.revalidate('/work/caxri/.git', topology);
        expect(originRemote).toHaveBeenCalledTimes(1);
        expect(originRemote).toHaveBeenCalledWith('/work/caxri');

        // The unknown root left the cache, so its next use reads again; the other repository kept its answer.
        await facts.host('/unknown/root');
        await facts.host('/other/repo');
        expect(originRemote.mock.calls.map(([root]) => root)).toEqual([
            '/work/caxri',
            '/unknown/root',
        ]);
    });

    it('drops removed worktrees instead of spawning Git in them', async () => {
        const originRemote = vi.fn(() => Promise.resolve('git@github.com:tjx666/caxri.git'));
        const existing = new Set(['/work/caxri-live']);
        const topology = { repositoryKeyForRoot: () => '/work/caxri/.git' };
        const facts = new OriginRemoteFacts(originRemote, undefined, (root) =>
            Promise.resolve(existing.has(root)),
        );
        await facts.host('/work/caxri-gone');
        await facts.host('/work/caxri-live');
        originRemote.mockClear();

        await facts.revalidate('/work/caxri/.git', topology);
        expect(originRemote.mock.calls).toEqual([['/work/caxri-live']]);
        await facts.host('/work/caxri-gone');
        expect(originRemote).toHaveBeenLastCalledWith('/work/caxri-gone');
    });
});
