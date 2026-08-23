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
        expect(coordinator.isOwnEcho('settings', 'in-flight')).toBe(false);
        inFlight.resolve(applied);
        await inFlight.promise;
        await Promise.resolve();
        expect(applied).not.toHaveBeenCalled();
    });

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'keeps the next pending %s draft when the previous write echoes before its response',
        async (kind) => {
            vi.useFakeTimers();
            const applied: string[] = [];
            const firstResponse = Promise.withResolvers<() => void>();
            const persist = vi
                .fn()
                .mockReturnValueOnce(firstResponse.promise)
                .mockResolvedValueOnce(() => applied.push('second-source'));
            const coordinator = createSettingsWriteCoordinator({
                debounceMs: 300,
                onError: vi.fn(),
                persist,
            });

            coordinator.persistNow(kind, 'first-source');
            coordinator.schedule(kind, 'second-source');

            expect(coordinator.isOwnEcho(kind, 'first-source')).toBe(true);
            firstResponse.resolve(() => applied.push('first-source'));
            await firstResponse.promise;
            await Promise.resolve();
            expect(applied).toEqual([]);

            await vi.advanceTimersByTimeAsync(300);

            expect(persist).toHaveBeenNthCalledWith(1, kind, 'first-source');
            expect(persist).toHaveBeenNthCalledWith(2, kind, 'second-source');
            expect(applied).toEqual(['second-source']);
        },
    );
});
