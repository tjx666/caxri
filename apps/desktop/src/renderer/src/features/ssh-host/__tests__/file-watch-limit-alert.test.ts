import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    dismissToastsMatching: vi.fn(
        (shouldDismiss: (title: string) => boolean): unknown => shouldDismiss,
    ),
    pushToast: vi.fn<(kind: string, message: string, options?: unknown) => void>(),
    listeners: [] as Array<(event: unknown) => void>,
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: {
        onEvent: (listener: (event: unknown) => void) => {
            mocks.listeners.push(listener);
            return () => {};
        },
    },
}));

vi.mock('../../../stores/toasts', () => ({
    dismissToastsMatching: mocks.dismissToastsMatching,
    pushToast: mocks.pushToast,
}));

import {
    reportFileWatchLimitAlert,
    subscribeFileWatchLimitAlerts,
} from '../file-watch-limit-alert';

function wasDismissed(title: string): boolean {
    return mocks.dismissToastsMatching.mock.calls.some(([shouldDismiss]) => shouldDismiss(title));
}

describe('reportFileWatchLimitAlert', () => {
    beforeEach(() => {
        reportFileWatchLimitAlert({ state: 'cleared' });
        vi.clearAllMocks();
    });

    it('shows one persistent notice per episode with the command that raises the limit', () => {
        reportFileWatchLimitAlert({ state: 'raised', reason: 'watch-limit' });
        reportFileWatchLimitAlert({ state: 'raised', reason: 'watch-limit' });

        expect(mocks.pushToast).toHaveBeenCalledOnce();
        const [kind, message, options] = mocks.pushToast.mock.calls[0] ?? [];
        expect(kind).toBe('warning');
        expect(message).toContain('fs.inotify.max_user_watches');
        expect(options).toMatchObject({ persist: true, action: { id: 'clipboard.copyCommand' } });
        expect(JSON.stringify(options)).toContain('fs.inotify.max_user_watches=524288');
    });

    it('retracts the notice once the Server reports the episode over, and notifies the next one', () => {
        reportFileWatchLimitAlert({ state: 'raised', reason: 'instance-limit' });
        const message = mocks.pushToast.mock.calls[0]?.[1] ?? '';
        reportFileWatchLimitAlert({ state: 'cleared' });
        expect(wasDismissed(message)).toBe(true);

        reportFileWatchLimitAlert({ state: 'raised', reason: 'instance-limit' });
        expect(mocks.pushToast).toHaveBeenCalledTimes(2);
    });

    it('replaces the notice when a different limit is hit', () => {
        reportFileWatchLimitAlert({ state: 'raised', reason: 'watch-limit' });
        const first = mocks.pushToast.mock.calls[0]?.[1] ?? '';
        reportFileWatchLimitAlert({ state: 'raised', reason: 'instance-limit' });

        expect(wasDismissed(first)).toBe(true);
        expect(mocks.pushToast.mock.calls[1]?.[1]).toContain('fs.inotify.max_user_instances');
    });

    it('retracts the notice when the Server connection is replaced, so the new Server can raise it again', () => {
        subscribeFileWatchLimitAlerts();
        const emit = (event: unknown) => {
            for (const listener of mocks.listeners) listener(event);
        };
        emit({
            event: 'files.watchLimitAlert',
            payload: { state: 'raised', reason: 'watch-limit' },
        });
        const message = mocks.pushToast.mock.calls[0]?.[1] ?? '';
        emit({ event: 'host.connectionChanged', payload: { status: 'reconnected' } });
        expect(wasDismissed(message)).toBe(true);

        emit({
            event: 'files.watchLimitAlert',
            payload: { state: 'raised', reason: 'watch-limit' },
        });
        expect(mocks.pushToast).toHaveBeenCalledTimes(2);
    });
});
