import { describe, expect, it, vi } from 'vitest';

import {
    GITHUB_TOKEN_FAILURE_BACKOFF_MS,
    GITHUB_TOKEN_SIGNED_OUT_BACKOFF_MS,
    GitHubTokenCache,
} from '../github-token';

describe('GitHubTokenCache', () => {
    it('shares one read between concurrent calls and reuses the token after it', async () => {
        const readToken = vi.fn(() => Promise.resolve('gho_one\n'));
        const cache = new GitHubTokenCache(readToken, () => false);

        const reads = await Promise.all([cache.read(), cache.read(), cache.read()]);
        for (const read of reads) expect(read).toEqual({ kind: 'token', token: 'gho_one' });
        await cache.read();
        expect(readToken).toHaveBeenCalledOnce();
    });

    it('parks gh after a failed read instead of asking the Keychain again on every call', async () => {
        let now = 1_000;
        const denied = new Error('keychain locked');
        const readToken = vi.fn(() => Promise.reject(denied));
        const cache = new GitHubTokenCache(
            readToken,
            () => false,
            () => now,
        );

        expect(await cache.read()).toEqual({ kind: 'parked', error: denied });
        now += GITHUB_TOKEN_FAILURE_BACKOFF_MS - 1;
        expect(await cache.read()).toEqual({ kind: 'parked', error: denied });
        expect(readToken).toHaveBeenCalledOnce();
        now += 1;
        await cache.read();
        expect(readToken).toHaveBeenCalledTimes(2);
    });

    it('rechecks a signed-out gh after a minute', async () => {
        let now = 0;
        const readToken = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('not logged in'))
            .mockResolvedValueOnce('gho_new');
        const cache = new GitHubTokenCache(
            readToken,
            () => true,
            () => now,
        );

        expect((await cache.read()).kind).toBe('parked');
        now += GITHUB_TOKEN_SIGNED_OUT_BACKOFF_MS;
        expect(await cache.read()).toEqual({ kind: 'token', token: 'gho_new' });
    });

    it('reads again after GitHub rejects the cached token', async () => {
        const readToken = vi
            .fn<() => Promise<string>>()
            .mockResolvedValueOnce('gho_old')
            .mockResolvedValueOnce('gho_new');
        const cache = new GitHubTokenCache(readToken, () => false);

        await cache.read();
        cache.invalidate('gho_stale');
        expect(await cache.read()).toEqual({ kind: 'token', token: 'gho_old' });
        cache.invalidate('gho_old');
        expect(await cache.read()).toEqual({ kind: 'token', token: 'gho_new' });
    });
});
