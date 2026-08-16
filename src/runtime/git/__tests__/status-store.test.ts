import { describe, expect, it, vi } from 'vitest';

import { RepoStatusStore } from '../status';

const ROOT = '/repo';

describe('RepoStatusStore', () => {
    it('produces once per generation and coalesces later consumers', async () => {
        const store = new RepoStatusStore<number>();
        let loads = 0;
        const load = () => {
            loads += 1;
            return Promise.resolve(loads);
        };
        const first = await store.status(ROOT, load);
        expect(first.outcome).toBe('fresh');
        expect(first.status).toBe(1);
        const second = await store.status(ROOT, load);
        expect(second.outcome).toBe('coalesced');
        expect(second.status).toBe(1);
        expect(loads).toBe(1);
    });

    it('joins an in-flight production instead of spawning a second one', async () => {
        const store = new RepoStatusStore<string>();
        const production = Promise.withResolvers<string>();
        let loads = 0;
        const load = () => {
            loads += 1;
            return production.promise;
        };
        const first = store.status(ROOT, load);
        const second = store.status(ROOT, load);
        production.resolve('produced');
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.outcome).toBe('fresh');
        expect(secondResult.outcome).toBe('joined');
        expect(secondResult.status).toBe('produced');
        expect(loads).toBe(1);
    });

    it('re-produces after a generation bump', async () => {
        const store = new RepoStatusStore<number>();
        let loads = 0;
        const load = () => {
            loads += 1;
            return Promise.resolve(loads);
        };
        await store.status(ROOT, load);
        store.bump(ROOT);
        const updated = await store.status(ROOT, load);
        expect(updated.outcome).toBe('fresh');
        expect(updated.status).toBe(2);
        expect(loads).toBe(2);
    });

    it('never lets a superseded production overwrite the newest generation', async () => {
        const store = new RepoStatusStore<number>();
        let loads = 0;
        const pending: Array<(value: number) => void> = [];
        const load = () => {
            loads += 1;
            return new Promise<number>((resolve) => {
                pending.push(resolve);
            });
        };
        const inFlight = store.status(ROOT, load);
        // The change lands while the first production is still running.
        store.bump(ROOT);
        pending[0](1);
        // The store must trail into a second production at the new generation.
        await vi.waitFor(() => expect(loads).toBe(2));
        pending[1](2);
        const result = await inFlight;
        expect(result.status).toBe(2);
        expect(result.generation).toBe(store.generation(ROOT));
        const cached = await store.status(ROOT, load);
        expect(cached.outcome).toBe('coalesced');
        expect(cached.status).toBe(2);
        expect(loads).toBe(2);
    });

    it('does not cache a failed production', async () => {
        const store = new RepoStatusStore<number>();
        let loads = 0;
        const load = () => {
            loads += 1;
            if (loads === 1) return Promise.reject(new Error('spawn failed'));
            return Promise.resolve(loads);
        };
        await expect(store.status(ROOT, load)).rejects.toThrow('spawn failed');
        const retried = await store.status(ROOT, load);
        expect(retried.outcome).toBe('fresh');
        expect(retried.status).toBe(2);
    });

    it('releases roots outside the referenced set', async () => {
        const store = new RepoStatusStore<number>();
        await store.status(ROOT, () => Promise.resolve(1));
        await store.status('/other', () => Promise.resolve(2));
        store.bump('/other');
        store.retainOnly(new Set([ROOT]));
        expect(store.generation('/other')).toBe(0);
        const kept = await store.status(ROOT, () => Promise.resolve(3));
        expect(kept.outcome).toBe('coalesced');
        expect(kept.status).toBe(1);
    });
});
