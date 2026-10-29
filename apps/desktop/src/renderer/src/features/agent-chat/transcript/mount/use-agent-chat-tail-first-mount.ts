import { startTransition, useCallback, useEffect, useState } from 'react';

/**
 * Entries mounted by the first commit of a Chat that already holds a conversation: enough to fill a view at the end,
 * few enough that a Markdown-heavy Chat paints in one short frame.
 */
export const AGENT_CHAT_TAIL_ENTRIES = 4;

/**
 * Entries each idle backfill commit mounts above the ones already there, sized to stay far below a long frame.
 */
export const AGENT_CHAT_BACKFILL_ENTRIES = 6;

/**
 * Longest an idle backfill waits before it runs anyway, so a busy main thread cannot leave the history unmounted.
 */
const BACKFILL_TIMEOUT_MS = 250;

/**
 * Index of the first entry the first commit mounts: the last {@link AGENT_CHAT_TAIL_ENTRIES}, or all of a short Chat.
 */
export function agentChatTailStart(total: number): number {
    return Math.max(total - AGENT_CHAT_TAIL_ENTRIES, 0);
}

/**
 * Index of the first entry after one more backfill commit mounts {@link AGENT_CHAT_BACKFILL_ENTRIES} above `start`.
 */
export function agentChatBackfillStart(start: number): number {
    return Math.max(start - AGENT_CHAT_BACKFILL_ENTRIES, 0);
}

/**
 * Runs `callback` when the main thread is idle, or after {@link BACKFILL_TIMEOUT_MS}; returns the cancel function.
 */
function whenIdle(callback: () => void): () => void {
    if (typeof requestIdleCallback === 'function') {
        const handle = requestIdleCallback(callback, { timeout: BACKFILL_TIMEOUT_MS });
        return () => cancelIdleCallback(handle);
    }
    const handle = setTimeout(callback, 16);
    return () => clearTimeout(handle);
}

/**
 * Mounts a Chat's timeline tail first. Switching back to a long Chat that left keep-alive remounts the whole pane, and
 * rendering every entry in that one frame froze the switch; this mounts only the last few entries, then adds older ones
 * above them in idle batches until the whole timeline is there. Entries keep their keys, so a backfill only adds rows
 * above and never remounts one. A view that follows the end stays there as rows go in above it, and one that does not
 * is held by the browser's scroll anchoring.
 *
 * The first non-empty timeline decides the tail, so a Chat that streams from empty mounts everything at once.
 * `mountAll` ends the backfill at once, for readers that need every entry in the DOM, such as find.
 *
 * @returns `start`, the index of the first entry to mount, and `mountAll`.
 */
export function useAgentChatTailFirstMount(total: number): {
    start: number;
    mountAll: () => void;
} {
    const [isDecided, setDecided] = useState(false);
    const [start, setStart] = useState(0);
    if (!isDecided && total > 0) {
        // Adjusting state during render makes the first committed tree the tail-only one.
        setDecided(true);
        setStart(agentChatTailStart(total));
    }
    const mountAll = useCallback(() => setStart(0), []);
    useEffect(() => {
        if (start <= 0) return;
        return whenIdle(() => {
            startTransition(() => setStart(agentChatBackfillStart));
        });
    }, [start]);
    return { start: Math.min(start, total), mountAll };
}
