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
    viewEventScopeKey,
} from '../view-event-bridge';

const scope = {
    viewId: 'publisher.fixture.sourceControl',
    sessionId: 'session-1',
    workbenchRootProjectId: 'project-1',
    extensionGeneration: 3,
};
const defaultContext = {
    kind: 'session' as const,
    sessionId: 'session-1',
    workbenchRootProjectId: 'project-1',
};

function event(
    eventId: string,
    context: Extract<
        ServerEvent,
        { event: 'viewContainers.viewChanged' }
    >['payload']['context'] = defaultContext,
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
                    workbenchRootProjectId: 'project-1',
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

    it('does not queue a no-session event for later replay', () => {
        startViewEventBridge();
        const orphan = event('event-no-session', { kind: 'no-session' });
        for (const listener of mocks.listeners) listener(orphan);
        const received: ServerEvent[] = [];
        subscribeViewEvents(scope, (next) => received.push(next));
        expect(received).toEqual([]);
    });

    it('delivers to a later subscriber of the same scope when an earlier one throws', () => {
        startViewEventBridge();
        const failing = vi.fn(() => {
            throw new Error('view event listener failure');
        });
        const surviving = vi.fn();
        subscribeViewEvents(scope, failing);
        subscribeViewEvents(scope, surviving);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const viewEvent = event('event-fanout');
        for (const listener of mocks.listeners) listener(viewEvent);

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledExactlyOnceWith(viewEvent);
        vi.restoreAllMocks();
    });

    it('uses the same key for a Session-scoped event and its matching subscriber', () => {
        expect(
            viewEventScopeKey({
                viewId: scope.viewId,
                sessionId: scope.sessionId,
                workbenchRootProjectId: scope.workbenchRootProjectId,
            }),
        ).toBe(`${scope.viewId}\0${scope.sessionId}\0${scope.workbenchRootProjectId}`);
    });

    it('evicts the oldest pending Session key once the pending-key cap is reached', () => {
        startViewEventBridge();
        const first = event('event-oldest', {
            kind: 'session',
            sessionId: 'session-oldest',
            workbenchRootProjectId: 'project-1',
        });
        for (const listener of mocks.listeners) listener(first);
        for (let index = 0; index < 64; index += 1) {
            const extra = event(`event-cap-${index}`, {
                kind: 'session',
                sessionId: `session-cap-${index}`,
                workbenchRootProjectId: 'project-1',
            });
            for (const listener of mocks.listeners) listener(extra);
        }
        const oldest = vi.fn();
        const newest = vi.fn();
        subscribeViewEvents({ ...scope, sessionId: 'session-oldest' }, oldest);
        subscribeViewEvents({ ...scope, sessionId: 'session-cap-63' }, newest);
        expect(oldest).not.toHaveBeenCalled();
        expect(newest).toHaveBeenCalledExactlyOnceWith(
            event('event-cap-63', {
                kind: 'session',
                sessionId: 'session-cap-63',
                workbenchRootProjectId: 'project-1',
            }),
        );
    });
});
