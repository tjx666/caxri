import { describe, expect, it, vi } from 'vitest';

import type { PresenceWindow } from '../window-presence-registry';
import {
    currentRequestWindowKey,
    runInRequestWindowKey,
    WindowPresenceRegistry,
    withWindowKey,
} from '../window-presence-registry';

type Listener = () => void;

class FakeWindow implements PresenceWindow {
    private readonly listeners = new Map<string, Listener[]>();
    destroyed = false;
    focused = false;
    minimized = false;
    shown = true;
    isDestroyed = () => this.destroyed;
    isFocused = () => this.focused;
    isMinimized = () => this.minimized;
    isVisible = () => this.shown;

    on(event: string, listener: Listener) {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
        return this;
    }

    emit(event: string) {
        const listeners = this.listeners.get(event) ?? [];
        for (const listener of listeners) listener();
    }
}

function fixture(now = () => 100) {
    const reports: Array<Record<string, unknown>> = [];
    const closes: string[] = [];
    const onSendError = vi.fn();
    const registry = new WindowPresenceRegistry({
        closePresence: (windowKey) => {
            closes.push(windowKey);
            return Promise.resolve();
        },
        now,
        onSendError,
        reportPresence: (report) => {
            reports.push({ ...report });
            return Promise.resolve();
        },
    });
    return { closes, onSendError, registry, reports };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('WindowPresenceRegistry', () => {
    it('reports a window when it registers and on every native visibility or focus change', async () => {
        const { registry, reports } = fixture();
        const window = new FakeWindow();
        registry.register('main', {}, window);
        window.focused = true;
        window.emit('focus');
        window.focused = false;
        window.minimized = true;
        window.emit('minimize');
        window.minimized = false;
        window.emit('restore');
        await flush();

        expect(reports.map(({ focused, visible }) => [focused, visible])).toEqual([
            [false, true],
            [true, true],
            [false, false],
            [false, true],
        ]);
    });

    it('never lets a hidden or minimized window claim focus', async () => {
        const { registry, reports } = fixture();
        const window = new FakeWindow();
        window.focused = true;
        window.shown = false;
        registry.register('main', {}, window);
        await flush();
        expect(reports[0]).toMatchObject({ focused: false, visible: false });
    });

    it('reports a viewed Session only when it changes', async () => {
        const { registry, reports } = fixture();
        registry.register('main', {}, new FakeWindow());
        registry.setViewing('main', 's1');
        registry.setViewing('main', 's1');
        registry.setViewing('missing', 's2');
        await flush();
        expect(reports.map((report) => report.viewingSessionId)).toEqual([null, 's1']);
    });

    it('forgets a closed window but keeps resolving its sender', async () => {
        const { closes, registry, reports } = fixture();
        const owner = {};
        const window = new FakeWindow();
        registry.register('main', owner, window);
        window.destroyed = true;
        window.emit('closed');
        window.emit('focus');
        await flush();

        expect(closes).toEqual(['main']);
        expect(reports).toHaveLength(1);
        expect(registry.keyOf(owner)).toBe('main');
        expect(registry.keyOf({})).toBeUndefined();
        registry.setViewing('main', 's1');
        expect(registry.isSessionShown('s1')).toBe(false);
    });

    it('ignores events of a window that a reopened one replaced', async () => {
        const { closes, registry } = fixture();
        const first = new FakeWindow();
        registry.register('main', {}, first);
        const second = new FakeWindow();
        registry.register('main', {}, second);
        first.emit('closed');
        await flush();
        expect(closes).toEqual([]);
    });

    it('swallows a connection outage but surfaces a real send failure', async () => {
        const onSendError = vi.fn();
        const failures = [
            Object.assign(new Error('unavailable'), { code: 'UNAVAILABLE' }),
            new Error('boom'),
        ];
        const registry = new WindowPresenceRegistry({
            closePresence: () => Promise.resolve(),
            onSendError,
            reportPresence: () => {
                const failure = failures.shift();
                return failure ? Promise.reject(failure) : Promise.resolve();
            },
        });
        const window = new FakeWindow();
        registry.register('main', {}, window);
        window.emit('focus');
        await flush();
        expect(onSendError).toHaveBeenCalledTimes(1);
        expect(onSendError).toHaveBeenCalledWith(new Error('boom'));
    });

    it('treats a synchronous throw from the sender as a failed send, not a crash', async () => {
        const onSendError = vi.fn();
        const registry = new WindowPresenceRegistry({
            closePresence: () => Promise.resolve(),
            onSendError,
            reportPresence: () => {
                throw new Error('no connection object yet');
            },
        });
        expect(() => registry.register('main', {}, new FakeWindow())).not.toThrow();
        await flush();
        expect(onSendError).toHaveBeenCalledTimes(1);
    });

    describe('isSessionShown', () => {
        it('requires a window that renders the Session and is focused, visible, and not minimized right now', () => {
            const { registry } = fixture();
            const window = new FakeWindow();
            registry.register('main', {}, window);
            registry.setViewing('main', 's1');
            expect(registry.isSessionShown('s1')).toBe(false);

            window.focused = true;
            expect(registry.isSessionShown('s1')).toBe(true);
            expect(registry.isSessionShown('s2')).toBe(false);

            window.minimized = true;
            expect(registry.isSessionShown('s1')).toBe(false);
            window.minimized = false;
            window.shown = false;
            expect(registry.isSessionShown('s1')).toBe(false);
            window.shown = true;
            window.destroyed = true;
            expect(registry.isSessionShown('s1')).toBe(false);
        });

        it('is true when any one of several windows shows the Session, and never falls back to the last focused', () => {
            const { registry } = fixture();
            const first = new FakeWindow();
            const second = new FakeWindow();
            registry.register('a', {}, first);
            registry.register('b', {}, second);
            registry.setViewing('a', 's1');
            registry.setViewing('b', 's2');
            first.focused = true;
            expect(registry.isSessionShown('s1')).toBe(true);
            expect(registry.isSessionShown('s2')).toBe(false);
            first.focused = false;
            second.focused = true;
            expect(registry.isSessionShown('s1')).toBe(false);
            expect(registry.isSessionShown('s2')).toBe(true);
        });
    });

    describe('seed', () => {
        it('sends every live window with its focus history as one snapshot', async () => {
            let now = 10;
            const { registry } = fixture(() => now);
            const first = new FakeWindow();
            const second = new FakeWindow();
            registry.register('a', {}, first);
            now = 20;
            second.focused = true;
            registry.register('b', {}, second);
            registry.setViewing('b', 's2');
            const send = vi.fn(() => Promise.resolve());

            await registry.seed(send);

            expect(send).toHaveBeenCalledTimes(1);
            expect(send).toHaveBeenCalledWith({
                windows: [
                    {
                        windowKey: 'a',
                        viewingSessionId: null,
                        focused: false,
                        visible: true,
                        focusedAt: 0,
                    },
                    {
                        windowKey: 'b',
                        viewingSessionId: 's2',
                        focused: true,
                        visible: true,
                        focusedAt: 20,
                    },
                ],
            });
        });

        it('sends an empty snapshot when no window is open', async () => {
            const { registry } = fixture();
            const send = vi.fn(() => Promise.resolve());
            await registry.seed(send);
            expect(send).toHaveBeenCalledWith({ windows: [] });
        });

        it('resends when a window changed while the snapshot was in flight', async () => {
            const { registry } = fixture();
            const window = new FakeWindow();
            registry.register('main', {}, window);
            const seen: unknown[] = [];
            const send = vi.fn((seed: { windows: Array<{ viewingSessionId: string | null }> }) => {
                seen.push(seed.windows[0].viewingSessionId);
                // The first snapshot is in flight when the Renderer navigates; the not-yet-attached connection drops
                // that live report, so only a resend can carry it.
                if (seen.length === 1) registry.setViewing('main', 's1');
                return Promise.resolve();
            });

            await registry.seed(send);

            expect(seen).toEqual([null, 's1']);
        });

        it('stops resending after a bounded number of attempts', async () => {
            const { registry } = fixture();
            registry.register('main', {}, new FakeWindow());
            let counter = 0;
            const send = vi.fn(() => {
                registry.setViewing('main', `s${(counter += 1)}`);
                return Promise.resolve();
            });
            await registry.seed(send, 3);
            expect(send).toHaveBeenCalledTimes(3);
        });
    });
});

describe('window key tagging', () => {
    it('adds the sender key to a window-scoped request and overwrites a key the Renderer supplied', () => {
        expect(withWindowKey('session.select', { sessionId: 's1' }, 'main')).toEqual({
            sessionId: 's1',
            windowKey: 'main',
        });
        expect(
            withWindowKey('session.select', { sessionId: 's1', windowKey: 'spoofed' }, 'main'),
        ).toEqual({ sessionId: 's1', windowKey: 'main' });
        expect(withWindowKey('window.openSessions.set', {}, 'main')).toEqual({ windowKey: 'main' });
    });

    it('leaves requests that act for no window, and senders without a key, untouched', () => {
        const parameters = { sessionId: 's1' };
        expect(withWindowKey('session.rename', parameters, 'main')).toBe(parameters);
        expect(withWindowKey('session.select', parameters, undefined)).toBe(parameters);
    });

    it('scopes the current key to the request being handled', async () => {
        expect(currentRequestWindowKey()).toBeUndefined();
        await runInRequestWindowKey('main', async () => {
            await Promise.resolve();
            expect(currentRequestWindowKey()).toBe('main');
        });
        expect(runInRequestWindowKey(undefined, () => currentRequestWindowKey())).toBeUndefined();
    });
});
