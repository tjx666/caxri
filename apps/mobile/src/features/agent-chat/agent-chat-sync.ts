import type { AgentChatPatch, AgentChatSnapshot, RevisionDecision } from '@caxri/protocol';
import {
    agentChatPatchSchema,
    applyAgentChatPatch,
    createRevisionConvergence,
    shouldAdoptRead,
} from '@caxri/protocol';

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

const POLL_INTERVAL_MS = 2_500;

/**
 * Keeps one phone copy of a Chat current. The first read travels right behind the subscribe instead of waiting for its
 * ACK, saving a round trip on a Relay; the Server turns a change it saw before the ACK into an `agentChat.changed`
 * hint, so a read that predates the change is corrected by a second one. The revision-chain policy (holding patches
 * during a read, replaying the newer ones, falling back to a fresh read on a gap, overflow, or invalid payload) is the
 * shared `createRevisionConvergence` core, and this reader owns the subscription, polling, timers, and read
 * serialization around it. Without a subscription the reader polls.
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
    let isReading = false;
    let isReadAgain = false;
    let isResyncRequired = false;
    let snapshot: AgentChatSnapshot | undefined;
    let handle: AgentChatSubscription | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const convergence = createRevisionConvergence<AgentChatPatch, AgentChatSnapshot>({
        apply: applyAgentChatPatch,
    });

    /**
     * Publishes what the core decided and reports whether it asked for a fresh read.
     */
    const requiresRead = (decision: RevisionDecision<AgentChatSnapshot>): boolean => {
        if (decision.publish) {
            snapshot = decision.publish;
            onSnapshot(decision.publish);
        }
        return decision.reread;
    };

    /**
     * Read through functions: the flags change in event callbacks while a read is awaited, which control-flow narrowing
     * cannot see.
     */
    const isCurrent = (): boolean => isActive;
    const hasQueuedRead = (): boolean => isReadAgain;

    /**
     * Reads are serialized so held patches replay onto one base; a read requested meanwhile runs after this one.
     */
    const drainReads = async (): Promise<void> => {
        isReadAgain = false;
        convergence.beginRead();
        try {
            const result = await read();
            if (!isCurrent()) return;
            if (shouldAdoptRead(snapshot, result)) {
                snapshot = result;
                onSnapshot(result);
            }
            if (requiresRead(convergence.settleRead(snapshot))) isReadAgain = true;
        } catch {
            convergence.abandonRead();
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
        const decision = parsed.success
            ? convergence.receivePatch(snapshot, parsed.data, isReading)
            : convergence.receiveUntrustedPatch();
        if (requiresRead(decision)) {
            void readLatest();
        }
    };

    const startPolling = (): void => {
        if (poll !== null) return;
        void readLatest();
        poll = setInterval(() => {
            void readLatest();
        }, POLL_INTERVAL_MS);
    };

    const release = (subscription: AgentChatSubscription): void => {
        void subscription.unsubscribe().catch(() => {});
    };

    if (subscribe) {
        void subscribe((event) => {
            if (!isActive || isResyncRequired) return;
            switch (event.kind) {
                case 'resync-required': {
                    isResyncRequired = true;
                    convergence.reset();
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
                    void readLatest();
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
            })
            .catch(() => {
                if (isActive && !isResyncRequired) startPolling();
            });
        void readLatest();
    } else startPolling();

    return () => {
        isActive = false;
        convergence.dispose();
        if (handle) release(handle);
        if (poll !== null) clearInterval(poll);
        if (retryTimer !== null) clearTimeout(retryTimer);
    };
};
