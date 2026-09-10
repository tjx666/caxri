import type { ServerEvent } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    listeners: [] as Array<(event: ServerEvent) => void>,
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: {
        onEvent: (listener: (event: ServerEvent) => void) => {
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
    viewId: 'publisher.fixture.sourceControl',
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
): Extract<ServerEvent, { event: 'viewContainers.viewChanged' }> {
    return {
        event: 'viewContainers.viewChanged',
        payload: {
            viewId: 'publisher.fixture.sourceControl',
            eventId,
            extensionGeneration,
            context,
            change: { kind: 'refresh' },
        },
    };
}

beforeEach(() => {
    resetViewEventBridgeForTests();
    mocks.listeners.length = 0;
});

describe('view event bridge', () => {
    it('does not queue badge invalidations ahead of a hidden view action', () => {
        startViewEventBridge();
        const action = event('refresh');
        for (const listener of mocks.listeners) listener(action);
        for (let index = 0; index < 100; index += 1) {
            const badge = event(`badge-${index}`);
            badge.payload.change = { kind: 'badge' };
            for (const listener of mocks.listeners) listener(badge);
        }
        const received: ServerEvent[] = [];
        subscribeViewEvents(scope, (next) => received.push(next));
        expect(received).toEqual([action]);
    });
    it('replays a hidden-view action once after the matching scope mounts', () => {
        startViewEventBridge();
        const viewEvent = event('event-1');
        for (const listener of mocks.listeners) listener(viewEvent);
        const received: ServerEvent[] = [];
        const unsubscribe = subscribeViewEvents(scope, (next) => received.push(next));

        expect(received).toEqual([viewEvent]);
        unsubscribe();
        const remountReceived: ServerEvent[] = [];
        subscribeViewEvents(scope, (next) => remountReceived.push(next));
        expect(remountReceived).toEqual([]);
    });

    it('drops duplicate ids and stale generation or context events', () => {
        startViewEventBridge();
        const received: ServerEvent[] = [];
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
        const received: ServerEvent[] = [];
        subscribeViewEvents(scope, (next) => received.push(next));
        const content = event('event-content');
        content.payload.change = { kind: 'content' };
        for (const listener of mocks.listeners) listener(content);
        expect(received).toEqual([]);
    });

    it('replays a provider selection into only the matching Session scope', () => {
        startViewEventBridge();
        const selection = event('event-selection');
        selection.payload.change = { kind: 'selection', selectedModeId: 'history' };
        for (const listener of mocks.listeners) listener(selection);
        const otherScope = vi.fn();
        const matchingScope = vi.fn();

        subscribeViewEvents({ ...scope, sessionId: 'session-2' }, otherScope);
        subscribeViewEvents(scope, matchingScope);

        expect(otherScope).not.toHaveBeenCalled();
        expect(matchingScope).toHaveBeenCalledExactlyOnceWith(selection);
    });
});
