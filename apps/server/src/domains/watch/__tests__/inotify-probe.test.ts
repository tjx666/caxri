import process from 'node:process';

import type parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchFailureReason } from '../failures';
import {
    canStartInotifyInstance,
    INOTIFY_START_FAILURE,
    withInotifyStartProbe,
} from '../inotify-probe';

const originalPlatform = process.platform;

function onPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function fakeSubscribe() {
    return vi.fn(() =>
        Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    ) as unknown as typeof parcelWatcher.subscribe & ReturnType<typeof vi.fn>;
}

describe('withInotifyStartProbe', () => {
    afterEach(() => {
        onPlatform(originalPlatform);
    });

    it('fails the first Linux subscription as an instance limit instead of letting the backend hang', async () => {
        onPlatform('linux');
        const subscribe = fakeSubscribe();
        const guarded = withInotifyStartProbe(
            subscribe,
            () => false,
            () => Promise.resolve(false),
        );

        let failure: unknown;
        try {
            await guarded('/srv/app', () => {});
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(INOTIFY_START_FAILURE);
        expect(watchFailureReason(failure)).toBe('instance-limit');
        expect(subscribe).not.toHaveBeenCalled();
    });

    it('subscribes once the probe passes, and skips it while a subscription keeps the backend alive', async () => {
        onPlatform('linux');
        const subscribe = fakeSubscribe();
        const probe = vi.fn(() => Promise.resolve(true));
        let isLive = false;
        const guarded = withInotifyStartProbe(subscribe, () => isLive, probe);

        await guarded('/srv/app', () => {});
        isLive = true;
        await guarded('/srv/app/other', () => {});

        expect(probe).toHaveBeenCalledOnce();
        expect(subscribe).toHaveBeenCalledTimes(2);
    });

    it('leaves other platforms unguarded', () => {
        onPlatform('darwin');
        const subscribe = fakeSubscribe();
        expect(withInotifyStartProbe(subscribe, () => false)).toBe(subscribe);
    });
});

describe('canStartInotifyInstance', () => {
    it('answers true where a child process can start a watcher', async () => {
        await expect(canStartInotifyInstance()).resolves.toBe(true);
    });
});
