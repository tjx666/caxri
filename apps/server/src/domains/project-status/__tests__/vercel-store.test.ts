import { describe, expect, it, vi } from 'vitest';

import type { BranchPublicationContext } from '../branch';
import type { VercelDependencies } from '../vercel';
import { VercelDeploymentStore } from '../vercel-store';

const head = 'a'.repeat(40);
const context: BranchPublicationContext = {
    branch: 'feat/panel',
    head,
    owner: 'acme',
    repo: 'widget',
    hasOrigin: true,
    detached: false,
};

function storeWith(readyState: string) {
    let now = 0;
    const store = new VercelDeploymentStore(() => Promise.resolve(''), { now: () => now });
    store.links.set('acme/widget', { team: 'team', project: 'widget' });
    const run = vi.fn<VercelDependencies['run']>(() =>
        Promise.resolve(
            JSON.stringify([
                {
                    created: 1_700_000_000_000,
                    readyState,
                    target: 'preview',
                    uid: 'dpl_feature_preview',
                    url: 'app-git-feature.example.vercel.app',
                    meta: { githubCommitRef: 'feat/panel', githubCommitSha: head },
                },
            ]),
        ),
    );
    const dependencies = { onParseFailure: () => {}, run };
    return {
        advance: (ms: number) => (now += ms),
        read: (isForced = false, next = context) =>
            store.deployments(dependencies, next, '/repo', undefined, isForced),
        run,
    };
}

describe('VercelDeploymentStore branch deployments', () => {
    it('shares one query across concurrent readers and reuses a settled answer for a minute', async () => {
        const { advance, read, run } = storeWith('READY');
        const [first, second] = await Promise.all([read(), read()]);
        expect(second).toBe(first);
        const calls = run.mock.calls.length;
        expect(calls).toBeGreaterThan(0);

        advance(59_000);
        await read();
        expect(run).toHaveBeenCalledTimes(calls);

        advance(1_000);
        await read();
        expect(run).toHaveBeenCalledTimes(calls * 2);
    });

    it('asks again sooner while a build is still running', async () => {
        const { advance, read, run } = storeWith('BUILDING');
        await read();
        const calls = run.mock.calls.length;
        advance(14_000);
        await read();
        expect(run).toHaveBeenCalledTimes(calls);
        advance(1_000);
        await read();
        expect(run).toHaveBeenCalledTimes(calls * 2);
    });

    it('queries at once for a forced refresh or a new HEAD', async () => {
        const { read, run } = storeWith('READY');
        await read();
        const calls = run.mock.calls.length;
        await read(true);
        expect(run).toHaveBeenCalledTimes(calls * 2);
        await read(false, { ...context, head: 'b'.repeat(40) });
        expect(run.mock.calls.length).toBeGreaterThan(calls * 2);
    });
});
