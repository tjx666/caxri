import { describe, expect, it, vi } from 'vitest';

import { OriginRemoteFacts } from '../origin-remote-facts';

describe('OriginRemoteFacts', () => {
    it('keeps the cached key until revalidated, then follows a changed origin', async () => {
        let remote = 'https://github.com/someone/caxri.git';
        const emit = vi.fn();
        const facts = new OriginRemoteFacts(() => Promise.resolve(remote), emit);
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
        const facts = new OriginRemoteFacts(() => Promise.resolve(remote), emit);
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
        const facts = new OriginRemoteFacts(originRemote);
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
        const facts = new OriginRemoteFacts(() => Promise.resolve(remote), emit);
        await facts.repositoryKey('/work/caxri');
        remote = '';
        await facts.revalidate();
        expect(emit).toHaveBeenCalledWith({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.repositoryKeys' },
        });
        expect(await facts.repositoryKey('/work/caxri')).toBeNull();
    });
});
