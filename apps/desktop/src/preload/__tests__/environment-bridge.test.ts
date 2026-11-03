import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createEnvironmentBridge } from '../environment-bridge';

function harness() {
    const handlers = new Map<string, (event: unknown, ...arguments_: unknown[]) => void>();
    const invoke = vi.fn((_channel: string, envelope: unknown) => {
        const { id, method } = envelope as { id: string; method: string };
        return Promise.resolve(
            method === 'events.recover'
                ? {
                      protocolVersion: 2,
                      id,
                      ok: true,
                      result: { kind: 'events', events: [], cursor: 0 },
                  }
                : { protocolVersion: 2, id, ok: true, result: null },
        );
    });
    const ipc = {
        invoke,
        on: vi.fn((channel: string, listener: (event: unknown, ...arguments_: unknown[]) => void) =>
            handlers.set(channel, listener),
        ),
        send: vi.fn(),
    };
    const reportError = vi.fn();
    const bridge = createEnvironmentBridge(ipc, reportError);
    const push = (environmentId: unknown, message: unknown) =>
        handlers.get('caxri:environment-event')?.({}, environmentId, message);
    return { bridge, invoke, ipc, push, reportError };
}

function changed(cursor: number) {
    return {
        protocolVersion: 2,
        cursor,
        event: { event: 'state.changed', payload: { kind: 'full' } } as ServerEvent,
    };
}

/**
 * Lets the attach-time recovery settle, so later envelopes are delivered rather than queued behind it.
 */
function settled(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

describe('preload SSH Host bridge', () => {
    it('sends a request with the SSH Host it names for Main to route', async () => {
        const { bridge, invoke } = harness();

        await bridge.requestWithId('dev@box:22', 'r1', 'app.health');

        expect(invoke).toHaveBeenCalledWith(
            'caxri:request',
            expect.objectContaining({ id: 'r1', method: 'app.health', params: {} }),
            'dev@box:22',
        );
    });

    it('delivers an attached Host event tagged with it and drops a detached or unknown Host event', async () => {
        const { bridge, ipc, push } = harness();
        const seen: Array<[string, string]> = [];
        bridge.onEvent((event, environmentId) => seen.push([event.event, environmentId]));

        bridge.attach('dev@box:22');
        bridge.attach('dev@box:22');
        expect(ipc.send).toHaveBeenCalledOnce();
        expect(ipc.send).toHaveBeenCalledWith('caxri:renderer-events-ready', 'dev@box:22');
        await settled();
        push('dev@box:22', changed(1));
        expect(seen).toEqual([['state.changed', 'dev@box:22']]);

        push('dev@other:22', changed(2));
        push(42, changed(2));
        bridge.detach('dev@box:22');
        push('dev@box:22', changed(2));

        expect(seen).toHaveLength(1);
    });

    it('keeps delivering to other listeners when one throws', async () => {
        const { bridge, push } = harness();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const second = vi.fn();
        bridge.onEvent(() => {
            throw new Error('boom');
        });
        bridge.onEvent(second);
        bridge.attach('dev@box:22');

        await settled();
        push('dev@box:22', changed(1));

        expect(second).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
});
