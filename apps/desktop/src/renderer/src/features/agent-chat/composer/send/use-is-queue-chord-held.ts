import { useSyncExternalStore } from 'react';

import { notifyListeners } from '@caxri/utils';

const listeners = new Set<() => void>();
const held = { isHeld: false };

/**
 * Whether the window's latest key event leaves Cmd or Ctrl down, the modifier that turns a running turn's Enter from
 * Steer into Queue (`agentChatComposerKeyAction`). Losing window focus counts as releasing it, since the key-up then
 * lands in another app and would otherwise leave the composer stuck on Queue.
 */
export function isQueueChordHeldAfter(event: Event): boolean {
    if (event.type === 'blur') return false;
    const { ctrlKey, metaKey } = event as KeyboardEvent;
    return metaKey || ctrlKey;
}

function track(event: Event): void {
    const isHeld = isQueueChordHeldAfter(event);
    if (isHeld === held.isHeld) return;
    held.isHeld = isHeld;
    notifyListeners(listeners, undefined, (error) =>
        console.error('agentChat.queueChord listener failed', error),
    );
}

/**
 * Key events are captured so a handler that stops propagation cannot hide them. `blur` is not: it does not bubble, so a
 * bubbling-phase window listener hears only the window itself losing focus, never focus moving between elements.
 */
const TRACKED_EVENTS = [
    ['keydown', true],
    ['keyup', true],
    ['blur', false],
] as const;

function subscribe(listener: () => void): () => void {
    if (listeners.size === 0)
        for (const [type, capture] of TRACKED_EVENTS) addEventListener(type, track, capture);
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        for (const [type, capture] of TRACKED_EVENTS) removeEventListener(type, track, capture);
        held.isHeld = false;
    };
}

/**
 * Whether Cmd or Ctrl is held right now, so the Send button can show what Enter would do before it is pressed. One set
 * of window listeners serves every composer, attached with the first subscriber and dropped with the last.
 */
export function useIsQueueChordHeld(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => held.isHeld,
        () => false,
    );
}
