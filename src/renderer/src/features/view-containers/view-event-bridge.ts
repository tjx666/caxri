import type { RuntimeEvent } from '@shared/ipc';

import { caxri } from '../../lib/caxri';

const MAX_PENDING_VIEW_EVENTS = 64;
const MAX_SEEN_VIEW_EVENT_IDS = 512;

type ViewChangedEvent = Extract<RuntimeEvent, { event: 'viewContainers.viewChanged' }>;
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

function scopeKey(scope: ViewEventScope): string {
    return `${scope.viewId}\0${scope.sessionId}\0${scope.workbenchProjectId}`;
}

function eventKey(event: ViewChangedEvent): string {
    const context = event.payload.context;
    return context.kind === 'no-session'
        ? `${event.payload.viewId}\0no-session`
        : `${event.payload.viewId}\0${context.sessionId}\0${context.workbenchProjectId}`;
}

function isReplayable(change: ViewChangedEvent['payload']['change']): boolean {
    return !['content', 'operation'].includes(change.kind);
}

function didRememberEventId(eventId: string): boolean {
    if (seenEventIds.has(eventId)) return false;
    seenEventIds.add(eventId);
    if (seenEventIds.size > MAX_SEEN_VIEW_EVENT_IDS)
        seenEventIds.delete(seenEventIds.values().next().value as string);
    return true;
}

function deliver(event: ViewChangedEvent): void {
    const key = eventKey(event);
    const current = listeners.get(key);
    if (!current || current.size === 0) {
        const queue = pending.get(key) ?? [];
        queue.push(event);
        if (queue.length > MAX_PENDING_VIEW_EVENTS) queue.shift();
        pending.set(key, queue);
        return;
    }
    for (const listener of current) listener(event);
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
    const key = scopeKey(scope);
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
