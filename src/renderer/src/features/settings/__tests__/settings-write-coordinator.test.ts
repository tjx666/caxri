import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSettingsWriteCoordinator } from '../settings-write-coordinator';

afterEach(() => {
    vi.useRealTimers();
});

describe('settings write coordinator', () => {
    it('coalesces a burst into the newest source for each config kind', async () => {
        vi.useFakeTimers();
        const applied: string[] = [];
        const persist = vi.fn((_kind, source: string) =>
            Promise.resolve(() => applied.push(source)),
        );
        const coordinator = createSettingsWriteCoordinator({
            debounceMs: 300,
            onError: vi.fn(),
            persist,
        });

        coordinator.schedule('settings', 'first');
        coordinator.schedule('settings', 'second');
        await vi.advanceTimersByTimeAsync(299);
        expect(persist).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(persist).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledWith('settings', 'second');
        expect(applied).toEqual(['second']);
    });

    it('drops a stale in-flight apply when a newer generation wins', async () => {
        const first = Promise.withResolvers<() => void>();
        const second = Promise.withResolvers<() => void>();
        const applied: string[] = [];
        const persist = vi
            .fn()
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);
        const coordinator = createSettingsWriteCoordinator({ onError: vi.fn(), persist });

        coordinator.persistNow('theme', 'first');
        coordinator.persistNow('theme', 'second');
        first.resolve(() => applied.push('first'));
        await first.promise;
        await Promise.resolve();
        second.resolve(() => applied.push('second'));
        await second.promise;
        await Promise.resolve();

        expect(applied).toEqual(['second']);
    });

    it('keeps debounce timers independent across config kinds', async () => {
        vi.useFakeTimers();
        const persisted: string[] = [];
        const coordinator = createSettingsWriteCoordinator({
            debounceMs: 300,
            onError: vi.fn(),
            persist: (kind, source) => Promise.resolve(() => persisted.push(`${kind}:${source}`)),
        });

        coordinator.schedule('settings', 'settings-source');
        await vi.advanceTimersByTimeAsync(100);
        coordinator.schedule('theme', 'theme-source');
        await vi.advanceTimersByTimeAsync(200);
        expect(persisted).toEqual(['settings:settings-source']);
        await vi.advanceTimersByTimeAsync(100);
        expect(persisted).toEqual(['settings:settings-source', 'theme:theme-source']);
    });

    it('lets an external change cancel pending and in-flight local writes', async () => {
        vi.useFakeTimers();
        const inFlight = Promise.withResolvers<() => void>();
        const applied = vi.fn();
        const persist = vi.fn().mockReturnValue(inFlight.promise);
        const coordinator = createSettingsWriteCoordinator({ onError: vi.fn(), persist });

        coordinator.schedule('settings', 'pending');
        coordinator.supersede('settings');
        await vi.runAllTimersAsync();
        expect(persist).not.toHaveBeenCalled();

        coordinator.persistNow('settings', 'in-flight');
        coordinator.supersede('settings');
        inFlight.resolve(applied);
        await inFlight.promise;
        await Promise.resolve();
        expect(applied).not.toHaveBeenCalled();
    });
});
