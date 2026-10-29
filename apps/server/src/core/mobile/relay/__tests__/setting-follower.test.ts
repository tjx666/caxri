import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../../domain-service';
import { createRelaySettingFollower } from '../setting-follower';

describe('createRelaySettingFollower', () => {
    it('applies each read in order and keeps going after a failed read', async () => {
        const values: Array<Error | string | null> = [
            'wss://relay.example.com',
            new Error('settings unavailable'),
            null,
        ];
        const request = vi.fn(() => {
            const next = values.shift();
            return next instanceof Error
                ? Promise.reject(next)
                : Promise.resolve({ value: { 'mobile.relayUrl': next } });
        });
        const configured: Array<string | null | undefined> = [];
        const configureRelay = vi.fn(async (url: string | null | undefined) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            configured.push(url);
        });
        const sync = createRelaySettingFollower({ configureRelay }, { request } as unknown as Pick<
            ServerDomainService,
            'request'
        >);

        sync();
        sync();
        sync();

        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(configured).toEqual(['wss://relay.example.com', null]));
        expect(request).toHaveBeenCalledWith('settings.get');
    });
});
