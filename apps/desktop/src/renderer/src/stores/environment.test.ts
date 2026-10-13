import type { EnvironmentState, ServerEvent } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    listeners: [] as Array<(event: ServerEvent) => void>,
    pushToast: vi.fn(),
    request: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('./toasts', () => ({ pushToast: mocks.pushToast }));

vi.mock('../lib/caxri', () => ({
    caxri: {
        onEvent: (listener: (event: ServerEvent) => void) => {
            mocks.listeners.push(listener);
            return () => {
                mocks.listeners = mocks.listeners.filter((candidate) => candidate !== listener);
            };
        },
        request: mocks.request,
    },
}));

import {
    getSshEnvironment,
    isLocalOnlyAvailable,
    isRemote,
    subscribeEnvironment,
    useEnvironmentStore,
} from './environment';

const connecting: EnvironmentState = {
    kind: 'ssh',
    destination: 'build-box',
    hostIdentity: 'build-box',
    phase: 'connecting',
    needsUserAction: false,
};
const connected: EnvironmentState = { ...connecting, phase: 'connected' };

function emit(payload: EnvironmentState): void {
    for (const listener of mocks.listeners) listener({ event: 'environment.changed', payload });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    return Promise.withResolvers<T>();
}

afterEach(() => {
    useEnvironmentStore.setState({ state: undefined });
    mocks.listeners = [];
    mocks.request.mockReset();
    mocks.pushToast.mockReset();
});

describe('environment predicates', () => {
    it('treats an unread environment as neither local nor remote', () => {
        expect(isRemote(undefined)).toBe(false);
        expect(isLocalOnlyAvailable(undefined)).toBe(false);
    });

    it('offers local-only actions only in a local window', () => {
        expect(isLocalOnlyAvailable({ kind: 'local' })).toBe(true);
        expect(isRemote({ kind: 'local' })).toBe(false);
        expect(isLocalOnlyAvailable(connected)).toBe(false);
        expect(isRemote(connected)).toBe(true);
    });
});

describe('subscribeEnvironment', () => {
    it('stores the initial read', async () => {
        mocks.request.mockResolvedValue({ kind: 'local' });
        const unsubscribe = subscribeEnvironment();
        await vi.waitFor(() =>
            expect(useEnvironmentStore.getState().state).toEqual({ kind: 'local' }),
        );
        expect(getSshEnvironment()).toBeUndefined();
        unsubscribe();
    });

    it('keeps an event that arrived while the initial read was in flight', async () => {
        const read = deferred<EnvironmentState>();
        mocks.request.mockReturnValue(read.promise);
        const unsubscribe = subscribeEnvironment();
        emit(connected);
        read.resolve(connecting);
        await read.promise;
        await Promise.resolve();
        expect(getSshEnvironment()?.phase).toBe('connected');
        unsubscribe();
    });

    it('follows later events and stops after unsubscribing', async () => {
        mocks.request.mockResolvedValue(connecting);
        const unsubscribe = subscribeEnvironment();
        await vi.waitFor(() => expect(getSshEnvironment()?.phase).toBe('connecting'));
        emit(connected);
        expect(getSshEnvironment()?.phase).toBe('connected');
        unsubscribe();
        emit(connecting);
        expect(getSshEnvironment()?.phase).toBe('connected');
    });

    it('explains a connect that Main answered by focusing this window', async () => {
        mocks.request.mockResolvedValue(connected);
        const unsubscribe = subscribeEnvironment();
        await vi.waitFor(() => expect(getSshEnvironment()?.destination).toBe('build-box'));
        for (const listener of mocks.listeners)
            listener({
                event: 'environment.connectionReused',
                payload: { destination: 'build-box-direct' },
            });

        expect(mocks.pushToast).toHaveBeenCalledWith(
            'info',
            'This window is already connected to build-box (same SSH Host as build-box-direct)',
        );
        unsubscribe();
    });

    it('ignores a read that resolves after unsubscribing', async () => {
        const read = deferred<EnvironmentState>();
        mocks.request.mockReturnValue(read.promise);
        const unsubscribe = subscribeEnvironment();
        unsubscribe();
        read.resolve(connecting);
        await read.promise;
        await Promise.resolve();
        expect(useEnvironmentStore.getState().state).toBeUndefined();
    });
});
