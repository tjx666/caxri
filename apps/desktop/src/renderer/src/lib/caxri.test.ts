import type { ServerEvent } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/confirmations', () => ({ showConfirm: vi.fn(), showConfirmChoice: vi.fn() }));

import { caxri } from './caxri';

const HOST = 'me@build-box:22';

type Listener = (event: ServerEvent, environmentId?: string) => void;

const local = new Set<(event: ServerEvent) => void>();
const remote = new Set<Listener>();

beforeEach(() => {
    Object.assign(globalThis, {
        caxri: {
            onEvent: (listener: (event: ServerEvent) => void) => {
                local.add(listener);
                return () => local.delete(listener);
            },
            environments: {
                onEvent: (listener: Listener) => {
                    remote.add(listener);
                    return () => remote.delete(listener);
                },
            },
        },
    });
});

afterEach(() => {
    local.clear();
    remote.clear();
    Reflect.deleteProperty(globalThis, 'caxri');
});

function emitLocal(event: ServerEvent): void {
    for (const listener of local) listener(event);
}

function emitRemote(event: ServerEvent): void {
    for (const listener of remote) listener(event, HOST);
}

const hooksChanged = { event: 'agentHooks.changed', payload: {} } as unknown as ServerEvent;

describe('caxri event subscriptions', () => {
    it('delivers an SSH Host event to onEvent with its environment id', () => {
        const listener = vi.fn();
        caxri.onEvent(listener);
        emitRemote(hooksChanged);
        emitLocal(hooksChanged);
        expect(listener).toHaveBeenNthCalledWith(1, hooksChanged, HOST);
        expect(listener).toHaveBeenNthCalledWith(2, hooksChanged);
    });

    it('delivers only this Mac events to onLocalEvent', () => {
        const listener = vi.fn();
        const unsubscribe = caxri.onLocalEvent(listener);
        emitRemote(hooksChanged);
        expect(listener).not.toHaveBeenCalled();
        emitLocal(hooksChanged);
        expect(listener).toHaveBeenCalledExactlyOnceWith(hooksChanged);
        unsubscribe();
        emitLocal(hooksChanged);
        expect(listener).toHaveBeenCalledOnce();
        expect(remote.size).toBe(0);
    });
});
