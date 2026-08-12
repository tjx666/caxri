import { describe, expect, it } from 'vitest';

import { startGoRun } from './start';

describe('Go isolated startup', () => {
    it('pins origin/main and preserves the main checkout while initializing the new worktree', async () => {
        const calls: string[] = [];
        const snapshots = ['main', 'head', ' M user-change', 'main', 'head', ' M user-change'];
        const result = await startGoRun(
            { branch: 'feat/go-isolation', objective: 'Deliver safely', runId: 'go-test' },
            '/repo',
            {
                capture: (_command, args, cwd) => {
                    calls.push(`${cwd}: ${args.join(' ')}`);
                    if (args.includes('--git-common-dir')) return Promise.resolve('/repo/.git');
                    if (args[0] === 'fetch') return Promise.resolve('');
                    if (args.join(' ') === 'rev-parse origin/main') return Promise.resolve('base');
                    if (cwd === '/repo-worktrees/go-isolation') {
                        return Promise.resolve(args[0] === 'branch' ? 'feat/go-isolation' : 'base');
                    }
                    return Promise.resolve(snapshots.shift() ?? '');
                },
                create: (branch, baseSha, mainCheckoutPath) => {
                    expect({ baseSha, branch, mainCheckoutPath }).toEqual({
                        baseSha: 'base',
                        branch: 'feat/go-isolation',
                        mainCheckoutPath: '/repo',
                    });
                    return Promise.resolve({ path: '/repo-worktrees/go-isolation' });
                },
                initialize: (worktreePath, input, metadata) => {
                    expect({ input, metadata, worktreePath }).toMatchObject({
                        input: { runId: 'go-test' },
                        metadata: { baseSha: 'base', mainCheckoutPath: '/repo' },
                        worktreePath: '/repo-worktrees/go-isolation',
                    });
                    return Promise.resolve(
                        '/repo-worktrees/go-isolation/.records/go/go-test/state.json',
                    );
                },
            },
        );

        expect(result).toMatchObject({
            baseSha: 'base',
            isolatedFromMain: true,
            mainCheckoutPath: '/repo',
            worktreePath: '/repo-worktrees/go-isolation',
        });
        expect(calls).toContain('/repo: fetch --quiet origin main');
    });

    it('fails if startup changes the main checkout snapshot', async () => {
        let statusReads = 0;
        await expect(
            startGoRun({ branch: 'feat/go-drift', objective: 'Detect drift' }, '/repo', {
                capture: (_command, args, cwd) => {
                    const joined = args.join(' ');
                    if (args.includes('--git-common-dir')) return Promise.resolve('/repo/.git');
                    if (args[0] === 'fetch') return Promise.resolve('');
                    if (joined === 'rev-parse origin/main') return Promise.resolve('base');
                    if (cwd === '/repo-worktrees/go-drift') {
                        return Promise.resolve(args[0] === 'branch' ? 'feat/go-drift' : 'base');
                    }
                    if (joined === 'branch --show-current') return Promise.resolve('main');
                    if (joined === 'rev-parse HEAD') return Promise.resolve('head');
                    statusReads += 1;
                    return Promise.resolve(statusReads === 1 ? '' : ' M changed');
                },
                create: () => Promise.resolve({ path: '/repo-worktrees/go-drift' }),
                initialize: () => Promise.resolve('/state.json'),
            }),
        ).rejects.toThrow('changed the main checkout');
    });

    it('rejects an existing branch that is not based on the pinned origin/main head', async () => {
        await expect(
            startGoRun({ branch: 'feat/stale-go', objective: 'Reject stale base' }, '/repo', {
                capture: (_command, args, cwd) => {
                    const joined = args.join(' ');
                    if (args.includes('--git-common-dir')) return Promise.resolve('/repo/.git');
                    if (args[0] === 'fetch') return Promise.resolve('');
                    if (joined === 'rev-parse origin/main') return Promise.resolve('base');
                    if (cwd === '/repo-worktrees/stale-go') {
                        return Promise.resolve(args[0] === 'branch' ? 'feat/stale-go' : 'stale');
                    }
                    if (joined === 'branch --show-current') return Promise.resolve('main');
                    if (joined === 'rev-parse HEAD') return Promise.resolve('head');
                    return Promise.resolve('');
                },
                create: () => Promise.resolve({ path: '/repo-worktrees/stale-go' }),
                initialize: () => Promise.resolve('/state.json'),
            }),
        ).rejects.toThrow('at the pinned origin/main');
    });
});
