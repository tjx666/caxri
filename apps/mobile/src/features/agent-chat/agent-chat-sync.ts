import type { AgentChatPatch, AgentChatSnapshot } from '@caxri/protocol';
import { agentChatPatchSchema, applyAgentChatPatch } from '@caxri/protocol';

interface AgentChatSubscription {
    unsubscribe(): Promise<void>;
}

/**
 * The subset of a mobile subscription message the reader acts on.
 */
export interface AgentChatSubscriptionEvent {
    kind: string;
    patch?: unknown;
}

/**
 * Patches held while a read is in flight. A burst beyond this is cheaper to re-read than to replay.
 */
const MAX_HELD_PATCHES = 200;

const POLL_INTERVAL_MS = 2_500;

/**
 * Keeps one phone copy of a Chat current. The first read follows the subscription ACK; patches that arrive during a
 * read are held and replayed on top of it when they are newer, and any gap in the revision chain (a missed patch, a
 * patch too large for one frame, an invalid payload) falls back to a fresh read. Without a subscription the reader
 * polls.
 */
export const startAgentChatReader = ({
    onError,
    onRetry,
    onSnapshot,
    read,
    subscribe,
}: {
    onError: () => void;
    /**
     * Called after the gateway asked for a resync; the owner re-creates the reader with a new subscription.
     */
    onRetry: () => void;
    onSnapshot: (snapshot: AgentChatSnapshot) => void;
    read: () => Promise<AgentChatSnapshot>;
    subscribe?: (
        onEvent: (event: AgentChatSubscriptionEvent) => void,
    ) => Promise<AgentChatSubscription>;
}): (() => void) => {
    let isActive = true;
    let isReady = false;
    let isReading = false;
    let isReadAgain = false;
    let isResyncRequired = false;
    let snapshot: AgentChatSnapshot | undefined;
    let held: AgentChatPatch[] = [];
    let isHeldOverflow = false;
    let handle: AgentChatSubscription | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const publish = (next: AgentChatSnapshot): void => {
        snapshot = next;
        if (isActive) onSnapshot(next);
    };

    /**
     * Folds patches onto the current copy. Returns false when the chain broke and a read is needed.
     */
    const canApplyPatches = (patches: readonly AgentChatPatch[]): boolean => {
        if (!snapshot) return false;
        let next = snapshot;
        for (const patch of patches) {
            if (patch.revision <= next.revision) continue;
            const applied = applyAgentChatPatch(next, patch);
            if (!applied) {
                if (next !== snapshot) publish(next);
                return false;
            }
            next = applied;
        }
        if (next !== snapshot) publish(next);
        return true;
    };

    /**
     * Read through functions: the flags change in event callbacks while a read is awaited, which control-flow narrowing
     * cannot see.
     */
    const isCurrent = (): boolean => isActive;
    const hasQueuedRead = (): boolean => isReadAgain;
    const takeHeld = (): { patches: AgentChatPatch[]; isOverflow: boolean } => {
        const taken = { patches: held, isOverflow: isHeldOverflow };
        held = [];
        isHeldOverflow = false;
        return taken;
    };

    /**
     * Reads are serialized so held patches replay onto one base; a read requested meanwhile runs after this one.
     */
    const drainReads = async (): Promise<void> => {
        isReadAgain = false;
        takeHeld();
        try {
            const result = await read();
            if (!isCurrent()) return;
            const replay = takeHeld();
            if (!snapshot || result.revision >= snapshot.revision) publish(result);
            if (replay.isOverflow || !canApplyPatches(replay.patches)) isReadAgain = true;
        } catch {
            if (isCurrent()) onError();
        }
        if (isCurrent() && hasQueuedRead()) await drainReads();
    };

    const readLatest = async (): Promise<void> => {
        if (!isActive) return;
        if (isReading) {
            isReadAgain = true;
            return;
        }
        isReading = true;
        try {
            await drainReads();
        } finally {
            isReading = false;
        }
    };

    const onPatch = (payload: unknown): void => {
        const parsed = agentChatPatchSchema.safeParse(payload);
        if (!parsed.success) {
            // eslint-disable-next-line no-void -- readLatest serializes recovery reads.
            void readLatest();
            return;
        }
        if (isReading || !snapshot) {
            if (held.length >= MAX_HELD_PATCHES) isHeldOverflow = true;
            else held.push(parsed.data);
            return;
        }
        if (!canApplyPatches([parsed.data])) {
            // eslint-disable-next-line no-void -- readLatest serializes recovery reads.
            void readLatest();
        }
    };

    const startPolling = (): void => {
        if (poll !== null) return;
        // eslint-disable-next-line no-void -- The reader disposer owns the interval and pending read.
        void readLatest();
        poll = setInterval(() => {
            // eslint-disable-next-line no-void -- Polling ends with the visible reader.
            void readLatest();
        }, POLL_INTERVAL_MS);
    };

    const release = (subscription: AgentChatSubscription): void => {
        // eslint-disable-next-line no-void -- Connection teardown also retires this subscription.
        void subscription.unsubscribe().catch(() => {});
    };

    if (subscribe) {
        // eslint-disable-next-line no-void -- The returned disposer owns the pending ACK and eventual handle.
        void subscribe((event) => {
            if (!isActive || isResyncRequired) return;
            switch (event.kind) {
                case 'resync-required': {
                    isResyncRequired = true;
                    if (handle) release(handle);
                    startPolling();
                    retryTimer = setTimeout(onRetry, POLL_INTERVAL_MS);
                    return;
                }
                case 'agentChat.patch': {
                    onPatch(event.patch);
                    return;
                }
                case 'agentChat.changed': {
                    // Before the ACK, the first read already covers this change.
                    // eslint-disable-next-line no-void -- readLatest serializes event-triggered reads.
                    if (isReady) void readLatest();
                    return;
                }
                default:
            }
        })
            .then((subscribed) => {
                if (!isActive || isResyncRequired) {
                    release(subscribed);
                    return;
                }
                handle = subscribed;
                isReady = true;
                // eslint-disable-next-line no-void -- Initial read follows the subscription ACK.
                void readLatest();
            })
            .catch(() => {
                if (isActive && !isResyncRequired) startPolling();
            });
    } else startPolling();

    return () => {
        isActive = false;
        if (handle) release(handle);
        if (poll !== null) clearInterval(poll);
        if (retryTimer !== null) clearTimeout(retryTimer);
    };
};
