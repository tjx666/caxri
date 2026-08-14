import type { ProcessState } from '@shared/types';
import { workItemsEqual, type WorkItem } from '@shared/work-item';

export type WorkTabNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'End' | 'Home';

/**
 * Produces a short DOM-safe suffix without putting a user-controlled path or identifier into the
 * DOM. Two independent 32-bit hashes keep practical collision risk low while bounding every ID.
 */
function idHash(value: string, seed: number): string {
    let hash = seed;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function workItemIdentity(sessionId: string, item: WorkItem): string {
    return `${sessionId}\u0000${item.kind}\u0000${item.kind === 'terminal' ? item.terminalId : item.path}`;
}

/** Returns the paired tab ID for the currently selected Session and work item. */
export function workTabId(sessionId: string, item: WorkItem): string {
    const identity = workItemIdentity(sessionId, item);
    return `work-tab-${idHash(identity, 0x811c9dc5)}-${idHash(identity, 0x9e3779b9)}`;
}

/** Returns the ID of the active work surface labelled by {@link workTabId}. */
export function workPanelId(sessionId: string, item: WorkItem): string {
    return `${workTabId(sessionId, item)}-panel`;
}

/** Calculates the roving-focus target with automatic activation for the tab composite. */
export function workTabNavigationTarget(
    items: readonly WorkItem[],
    active: WorkItem | undefined,
    key: WorkTabNavigationKey,
): WorkItem | undefined {
    if (items.length === 0) return undefined;
    if (key === 'Home') return items[0];
    if (key === 'End') return items.at(-1);
    const activeIndex = items.findIndex((item) => workItemsEqual(item, active));
    if (activeIndex === -1) return key === 'ArrowRight' ? items[0] : items.at(-1);
    const currentIndex = activeIndex;
    const delta = key === 'ArrowRight' ? 1 : -1;
    return items[(currentIndex + delta + items.length) % items.length];
}

/** Human-readable state exposed beside the visual terminal dot for screen readers. */
export function processStateDescription(state: ProcessState): string {
    switch (state) {
        case 'starting':
            return 'Terminal is starting';
        case 'running':
            return 'Terminal is running';
        case 'stopped':
            return 'Terminal is stopped';
        case 'dead':
            return 'Terminal has stopped unexpectedly';
        case 'failed':
            return 'Terminal failed';
        case 'interrupted':
            return 'Terminal was interrupted';
    }
}
