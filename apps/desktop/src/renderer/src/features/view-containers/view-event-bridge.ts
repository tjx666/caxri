import type { ServerEvent } from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';

import { caxri } from '../../lib/caxri';

const MAX_PENDING_VIEW_EVENTS = 64;
const MAX_PENDING_VIEW_EVENT_KEYS = 64;
const MAX_SEEN_VIEW_EVENT_IDS = 512;

type ViewChangedEvent = Extract<ServerEvent, { event: 'viewContainers.viewChanged' }>;
export interface ViewEventScope {
    viewId: string;
    sessionId: string;
    workbenchProjectId: string;
    extensionGeneration: number;
}

type ViewEventListener = (event: ViewChangedEvent) => void;

const pending = new Map<string, ViewChangedEvent[]>();
const listeners = new Map<string, Set<ViewEventListener>>();
const seenEventIds = new Set<string>();
const bridgeState: { unsubscribe?: () => void } = {};

export function viewEventScopeKey(
    scope: Pick<ViewEventScope, 'viewId' | 'sessionId' | 'workbenchProjectId'>,
): string {
    return `${scope.viewId}\0${scope.sessionId}\0${scope.workbenchProjectId}`;
}

function eventKey(event: ViewChangedEvent): string | undefined {
    const context = event.payload.context;
    if (context.kind === 'no-session') return;
    return viewEventScopeKey({
        viewId: event.payload.viewId,
        sessionId: context.sessionId,
        workbenchProjectId: context.workbenchProjectId,
    });
}

function isReplayable(change: ViewChangedEvent['payload']['change']): boolean {
    return change.kind === 'refresh' || change.kind === 'selection';
}

function didRememberEventId(eventId: string): boolean {
    if (seenEventIds.has(eventId)) return false;
    seenEventIds.add(eventId);
    if (seenEventIds.size > MAX_SEEN_VIEW_EVENT_IDS)
        seenEventIds.delete(seenEventIds.values().next().value as string);
    return true;
}

function enqueuePending(key: string, event: ViewChangedEvent): void {
    if (!pending.has(key) && pending.size >= MAX_PENDING_VIEW_EVENT_KEYS) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
    }
    const queue = pending.get(key) ?? [];
    queue.push(event);
    if (queue.length > MAX_PENDING_VIEW_EVENTS) queue.shift();
    pending.set(key, queue);
}

function deliver(event: ViewChangedEvent): void {
    const key = eventKey(event);
    if (!key) return;
    const current = listeners.get(key);
    if (!current || current.size === 0) {
        enqueuePending(key, event);
        return;
    }
    // Isolates each view-container subscriber so one throwing view controller cannot stop the event's other
    // subscribers from observing it; Desktop mirrors `console.error` into `logs/desktop.jsonl`.
    notifyListeners(current, event, (error) =>
        console.error('viewContainers.viewChanged listener failed', error),
    );
}

/**
 * Starts the one Renderer-wide subscription. Keeping this at the application boundary means a command emitted while a
 * view is hidden is retained here instead of depending on a mounted panel controller's effect timing.
 */
export function startViewEventBridge(): void {
    if (bridgeState.unsubscribe) return;
    bridgeState.unsubscribe = caxri.onEvent((event) => {
        if (event.event !== 'viewContainers.viewChanged' || !isReplayable(event.payload.change))
            return;
        if (!didRememberEventId(event.payload.eventId)) return;
        deliver(event);
    });
}

export function subscribeViewEvents(
    scope: ViewEventScope,
    listener: ViewEventListener,
): () => void {
    startViewEventBridge();
    const key = viewEventScopeKey(scope);
    const guardedListener: ViewEventListener = (event) => {
        if (event.payload.extensionGeneration === scope.extensionGeneration) listener(event);
    };
    const current = listeners.get(key) ?? new Set<ViewEventListener>();
    current.add(guardedListener);
    listeners.set(key, current);
    const queued = pending.get(key);
    if (queued) {
        pending.delete(key);
        for (const event of queued) guardedListener(event);
    }
    return () => {
        const active = listeners.get(key);
        if (!active) return;
        active.delete(guardedListener);
        if (active.size === 0) listeners.delete(key);
    };
}

/**
 * Test-only reset keeps the global bridge deterministic across isolated Renderer unit cases.
 */
export function resetViewEventBridgeForTests(): void {
    bridgeState.unsubscribe?.();
    bridgeState.unsubscribe = undefined;
    pending.clear();
    listeners.clear();
    seenEventIds.clear();
}
