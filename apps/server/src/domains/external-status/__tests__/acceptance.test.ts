import { describe, expect, it } from 'vitest';

import { AcceptanceStore } from '../acceptance';

const ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const BUNDLE = JSON.stringify({
    acceptance: { status: 'delivered' },
    latestReport: { passedChecks: 11, totalChecks: 12, verdict: 'passed' },
    rounds: [
        {
            report: { passedChecks: 11, totalChecks: 12, verdict: 'passed' },
            run: { roundIndex: 1 },
        },
    ],
    subject: { title: 'Recover a diff whose worker never started' },
});

function harness(respond: () => Promise<string>, options: Record<string, number> = {}) {
    const calls: string[][] = [];
    let now = 1_000;
    const store = new AcceptanceStore(
        async (arguments_) => {
            calls.push([...arguments_]);
            return respond();
        },
        { now: () => now, ...options },
    );
    return { calls, store, advance: (ms: number) => (now += ms) };
}

describe('Acceptance report store', () => {
    it('serves a repeated lookup from one CLI spawn and refetches after the report TTL', async () => {
        const { calls, store, advance } = harness(() => Promise.resolve(BUNDLE));
        await expect(store.report({ cwd: '/repo', id: ID })).resolves.toMatchObject({
            status: 'delivered',
            verdict: 'passed',
        });
        // The id is lower-cased into the cache key, so the same report addressed in another case is one request.
        await store.report({ cwd: '/repo', id: ID.toUpperCase() });
        expect(calls).toHaveLength(1);
        advance(90_001);
        await store.report({ cwd: '/repo', id: ID });
        expect(calls).toHaveLength(2);
    });

    it('refetches immediately when the caller demands a fresh read', async () => {
        const { calls, store } = harness(() => Promise.resolve(BUNDLE));
        await store.report({ cwd: '/repo', id: ID });
        await store.report({ cwd: '/repo', id: ID, maxAgeMs: 0 });
        expect(calls).toHaveLength(2);
    });

    /**
     * The failure window is the one that matters on a machine with no `lh` installed: without it every open Session
     * spawns a doomed process once a minute, forever.
     */
    it('remembers a failure for its own window, which the caller may shorten', async () => {
        const { calls, store, advance } = harness(
            () => Promise.reject(new Error('lh: not found')),
            { failureTtlMs: 5_000 },
        );
        await expect(store.report({ cwd: '/repo', id: ID })).rejects.toThrow('lh: not found');
        await expect(store.report({ cwd: '/repo', id: ID })).rejects.toThrow('lh: not found');
        expect(calls).toHaveLength(1);
        advance(5_001);
        await expect(store.report({ cwd: '/repo', id: ID })).rejects.toThrow();
        expect(calls).toHaveLength(2);
    });
});
