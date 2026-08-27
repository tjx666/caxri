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

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'keeps the next pending %s draft when the previous response fails before its delayed echo',
        async (kind) => {
            vi.useFakeTimers();
            const firstResponse = Promise.withResolvers<() => void>();
            const readResponse = Promise.withResolvers<() => void>();
            const appliedReads: string[] = [];
            const persist = vi
                .fn()
                .mockReturnValueOnce(firstResponse.promise)
                .mockResolvedValueOnce(vi.fn());
            const onError = vi.fn();
            const onExternalChange = vi.fn();
            const onOwnEcho = vi.fn();
            const read = vi.fn().mockReturnValue(readResponse.promise);
            const coordinator = createSettingsWriteCoordinator({
                currentSource: () => 'second-source',
                debounceMs: 300,
                onError,
                onExternalChange,
                onOwnEcho,
                persist,
                read,
            });

            coordinator.persistNow(kind, 'first-source');
            coordinator.schedule(kind, 'second-source');
            firstResponse.reject(new Error('response failed after Runtime broadcast'));
            await expect(firstResponse.promise).rejects.toThrow(
                'response failed after Runtime broadcast',
            );
            await Promise.resolve();

            expect(onError).toHaveBeenCalledOnce();
            expect(read).toHaveBeenCalledWith(kind);
            coordinator.handleChanged(kind, { source: 'first-source' });
            expect(onOwnEcho).toHaveBeenCalledWith(kind, 'first-source', false);
            expect(onExternalChange).not.toHaveBeenCalled();

            readResponse.resolve(() => appliedReads.push(kind));
            await readResponse.promise;
            await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(appliedReads).toEqual([kind]));
            await vi.advanceTimersByTimeAsync(300);

            expect(persist).toHaveBeenNthCalledWith(1, kind, 'first-source');
            expect(persist).toHaveBeenNthCalledWith(2, kind, 'second-source');
        },
    );

    it.each(['settings', 'keybindings', 'theme'] as const)(
        're-reads retired %s sources without cancelling a newer pending draft',
        async (kind) => {
            vi.useFakeTimers();
            const firstResponse = Promise.withResolvers<() => void>();
            const secondResponse = Promise.withResolvers<() => void>();
            const persist = vi
                .fn()
                .mockReturnValueOnce(firstResponse.promise)
                .mockReturnValueOnce(secondResponse.promise)
                .mockResolvedValueOnce(vi.fn());
            const onExternalChange = vi.fn();
            const onOwnEcho = vi.fn();
            const read = vi.fn().mockResolvedValue(vi.fn());
            const coordinator = createSettingsWriteCoordinator({
                debounceMs: 300,
                onError: vi.fn(),
                onExternalChange,
                onOwnEcho,
                persist,
                read,
            });

            coordinator.persistNow(kind, 'older-source');
            coordinator.persistNow(kind, 'confirmed-source');
            secondResponse.reject(new Error('confirmed write response failed'));
            await expect(secondResponse.promise).rejects.toThrow('confirmed write response failed');
            await Promise.resolve();
            await Promise.resolve();
            expect(read).toHaveBeenCalledTimes(1);

            coordinator.schedule(kind, 'pending-source');
            coordinator.handleChanged(kind, { source: 'older-source' });
            coordinator.handleChanged(kind, { source: 'confirmed-source' });

            expect(read).toHaveBeenCalledTimes(3);
            expect(onExternalChange).not.toHaveBeenCalled();
            expect(onOwnEcho).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(300);
            expect(persist).toHaveBeenNthCalledWith(3, kind, 'pending-source');
        },
    );

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'keeps the next pending %s draft when a local echo arrives during snapshot recovery',
        async (kind) => {
            vi.useFakeTimers();
            const response = Promise.withResolvers<() => void>();
            const readResponse = Promise.withResolvers<() => void>();
            const appliedReads: string[] = [];
            const onExternalChange = vi.fn();
            const onOwnEcho = vi.fn();
            const persist = vi
                .fn()
                .mockReturnValueOnce(response.promise)
                .mockResolvedValueOnce(vi.fn());
            const coordinator = createSettingsWriteCoordinator({
                currentSource: () => 'second-source',
                debounceMs: 300,
                onError: vi.fn(),
                onExternalChange,
                onOwnEcho,
                persist,
                read: vi.fn().mockReturnValue(readResponse.promise),
            });

            coordinator.persistNow(kind, 'first-source');
            coordinator.schedule(kind, 'second-source');
            const recovery = coordinator.reconcile(kind);
            coordinator.handleChanged(kind, { source: 'first-source' });

            expect(onOwnEcho).toHaveBeenCalledWith(kind, 'first-source', false);
            expect(onExternalChange).not.toHaveBeenCalled();

            readResponse.resolve(() => appliedReads.push(kind));
            await recovery;
            await vi.waitFor(() => expect(appliedReads).toEqual([kind]));
            await vi.advanceTimersByTimeAsync(300);

            expect(persist).toHaveBeenNthCalledWith(1, kind, 'first-source');
            expect(persist).toHaveBeenNthCalledWith(2, kind, 'second-source');
        },
    );

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'drops a stale %s recovery read after a newer local echo and follows it with a fresh read',
        async (kind) => {
            const persistResponse = Promise.withResolvers<() => void>();
            const firstRead = Promise.withResolvers<() => void>();
            const appliedReads: string[] = [];
            const read = vi
                .fn()
                .mockReturnValueOnce(firstRead.promise)
                .mockResolvedValueOnce(() => appliedReads.push('fresh'));
            const coordinator = createSettingsWriteCoordinator({
                currentSource: () => 'committed-source',
                onError: vi.fn(),
                onOwnEcho: vi.fn(),
                persist: vi.fn().mockReturnValue(persistResponse.promise),
                read,
            });

            coordinator.persistNow(kind, 'committed-source');
            const recovery = coordinator.reconcile(kind);
            coordinator.handleChanged(kind, { source: 'committed-source' });
            firstRead.resolve(() => appliedReads.push('stale'));
            await recovery;
            await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(appliedReads).toEqual(['fresh']));
        },
    );

    it.each(['settings', 'keybindings', 'theme'] as const)(
        're-reads an ambiguous %s source after snapshot recovery retires its token',
        async (kind) => {
            const response = Promise.withResolvers<() => void>();
            const onExternalChange = vi.fn();
            const read = vi.fn().mockResolvedValue(vi.fn());
            const coordinator = createSettingsWriteCoordinator({
                appliedSource: () => 'before-write',
                onError: vi.fn(),
                onExternalChange,
                persist: vi.fn().mockReturnValue(response.promise),
                read,
            });

            coordinator.persistNow(kind, 'committed-source');
            // The local `*.changed` envelope is lost when journal recovery falls back to a snapshot.
            await coordinator.reconcile(kind);
            coordinator.handleChanged(kind, { source: 'committed-source' });
            await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

            expect(read).toHaveBeenNthCalledWith(1, kind);
            expect(read).toHaveBeenNthCalledWith(2, kind);
            expect(onExternalChange).not.toHaveBeenCalled();
        },
    );

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'advances the applied %s baseline for a matching local echo',
        async (kind) => {
            const response = Promise.withResolvers<() => void>();
            const applied = vi.fn();
            const onOwnEcho = vi.fn();
            const coordinator = createSettingsWriteCoordinator({
                currentSource: () => 'local-source',
                onError: vi.fn(),
                onOwnEcho,
                persist: vi.fn().mockReturnValue(response.promise),
            });

            coordinator.persistNow(kind, 'local-source');
            coordinator.handleChanged(kind, { source: 'local-source' });
            response.resolve(applied);
            await response.promise;
            await Promise.resolve();

            expect(onOwnEcho).toHaveBeenCalledWith(kind, 'local-source', true);
            expect(applied).toHaveBeenCalledOnce();
        },
    );

    it.each(['settings', 'keybindings', 'theme'] as const)(
        'does not swallow an error-bearing %s event with the applied source',
        (kind) => {
            const onExternalChange = vi.fn();
            const read = vi.fn().mockResolvedValue(vi.fn());
            const coordinator = createSettingsWriteCoordinator({
                appliedSource: () => 'applied-source',
                onError: vi.fn(),
                onExternalChange,
                persist: vi.fn(() => new Promise<() => void>(() => {})),
                read,
            });

            coordinator.persistNow(kind, 'applied-source');
            coordinator.handleChanged(kind, {
                source: 'applied-source',
                error: 'watcher failed',
            });

            expect(read).toHaveBeenCalledWith(kind);
            expect(onExternalChange).toHaveBeenCalledWith(kind, {
                source: 'applied-source',
                error: 'watcher failed',
            });
        },
    );
});
