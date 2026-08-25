import type { RuntimeEvent } from '@shared/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    listeners: [] as Array<(event: RuntimeEvent) => void>,
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: {
        onEvent: (listener: (event: RuntimeEvent) => void) => {
            mocks.listeners.push(listener);
            return () => {
                const index = mocks.listeners.indexOf(listener);
                if (index !== -1) mocks.listeners.splice(index, 1);
            };
        },
    },
}));

import {
    resetViewEventBridgeForTests,
    startViewEventBridge,
    subscribeViewEvents,
} from '../view-event-bridge';

const scope = {
    viewId: 'publisher.fixture.files',
    sessionId: 'session-1',
    workbenchProjectId: 'project-1',
    extensionGeneration: 3,
};
const defaultContext = {
    kind: 'session' as const,
    sessionId: 'session-1',
    workbenchProjectId: 'project-1',
};

function event(
    eventId: string,
    context = defaultContext,
    extensionGeneration = 3,
): Extract<RuntimeEvent, { event: 'viewContainers.viewChanged' }> {
    return {
        event: 'viewContainers.viewChanged',
        payload: {
            viewId: 'publisher.fixture.files',
            eventId,
            extensionGeneration,
            context,
            change: { kind: 'search' },
        },
    };
}

beforeEach(() => {
    resetViewEventBridgeForTests();
    mocks.listeners.length = 0;
});

describe('view event bridge', () => {
    it('replays a hidden-view action once after the matching scope mounts', () => {
        startViewEventBridge();
        const viewEvent = event('event-1');
        for (const listener of mocks.listeners) listener(viewEvent);
        const received: RuntimeEvent[] = [];
        const unsubscribe = subscribeViewEvents(scope, (next) => received.push(next));

        expect(received).toEqual([viewEvent]);
        unsubscribe();
        const remountReceived: RuntimeEvent[] = [];
        subscribeViewEvents(scope, (next) => remountReceived.push(next));
        expect(remountReceived).toEqual([]);
    });

    it('drops duplicate ids and stale generation or context events', () => {
        startViewEventBridge();
        const received: RuntimeEvent[] = [];
        subscribeViewEvents(scope, (next) => received.push(next));
        const first = event('event-1');
        for (const listener of mocks.listeners) listener(first);
        for (const listener of mocks.listeners) listener(first);
        for (const listener of mocks.listeners)
            listener(
                event('event-2', {
                    kind: 'session',
                    sessionId: 'session-2',
                    workbenchProjectId: 'project-1',
                }),
            );
        for (const listener of mocks.listeners) listener(event('event-3', undefined, 2));

        expect(received).toEqual([first]);
    });

    it('does not retain content invalidations as action replay', () => {
        startViewEventBridge();
        const received: RuntimeEvent[] = [];
        subscribeViewEvents(scope, (next) => received.push(next));
        const content = event('event-content');
        content.payload.change = { kind: 'content', paths: ['src/file.ts'] };
        for (const listener of mocks.listeners) listener(content);
        expect(received).toEqual([]);
    });
});
