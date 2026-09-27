import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { nativeWatchProbeSource } from '../native-spike';

type Callback = (error: Error | null, events: Array<{ path: string }>) => void;
interface WatcherFixture {
    subscribe(root: string, callback: Callback): Promise<{ unsubscribe(): Promise<void> }>;
}

const require = createRequire(import.meta.url);

function fixture(eventPath?: string, hasError = false) {
    let callback: Callback | undefined;
    const unsubscribe = vi.fn(() => Promise.resolve());
    const watcher: WatcherFixture = {
        subscribe: vi.fn((_root: string, nextCallback: Callback) => {
            callback = nextCallback;
            return Promise.resolve({ unsubscribe });
        }),
    };
    const verify: unknown = runInNewContext(
        `${nativeWatchProbeSource}\nsubscribeAndVerifyWatcher`,
        {
            Date,
            process: { platform: 'darwin' },
            setTimeout,
            require: (name: string) =>
                name === 'node:fs/promises'
                    ? {
                          realpath: (path: string) => Promise.resolve(path),
                          writeFile: () => {
                              expect(callback).toBeTypeOf('function');
                              callback!(
                                  hasError ? new Error('synthetic failure') : null,
                                  eventPath ? [{ path: eventPath }] : [],
                              );
                              return Promise.resolve();
                          },
                      }
                    : (require(name) as unknown),
        },
    );
    const run = verify as (
        watcher: WatcherFixture,
        root: string,
        timeoutMs: number,
    ) => Promise<{ unsubscribe(): Promise<void> }>;
    return { run: () => run(watcher, '/fixture', 1), unsubscribe };
}

describe('artifact native watcher delivery probe', () => {
    it('requires the written file event and returns the live subscription for final cleanup', async () => {
        const probe = fixture('/fixture/watcher-delivery-probe.txt');
        const subscription = await probe.run();
        expect(probe.unsubscribe).not.toHaveBeenCalled();
        await subscription.unsubscribe();
        expect(probe.unsubscribe).toHaveBeenCalledOnce();
    });

    it.each([undefined, '/fixture/unrelated.txt'])(
        'rejects a silent or unrelated event stream (%s) and releases it',
        async (path) => {
            const probe = fixture(path);
            await expect(probe.run()).rejects.toThrow('delivered no probe event');
            expect(probe.unsubscribe).toHaveBeenCalledOnce();
        },
    );

    it('releases a stream that reports an error without exposing its message', async () => {
        const probe = fixture(undefined, true);
        await expect(probe.run()).rejects.toThrow(
            'Native watcher reported an error during the delivery probe',
        );
        expect(probe.unsubscribe).toHaveBeenCalledOnce();
    });
});
