interface ConversationEvent {
    kind: string;
}

interface ConversationSubscription {
    unsubscribe(): Promise<void>;
}

/**
 * Invalidation during an in-flight snapshot cannot be satisfied by that snapshot alone.
 */
export const readConversationSnapshot = async <Result>(
    read: () => Promise<Result>,
    eventVersion: () => number,
    onConcurrentEvent: () => void,
): Promise<Result> => {
    const before = eventVersion();
    const result = await read();
    if (eventVersion() !== before) onConcurrentEvent();
    return result;
};

/**
 * The first read follows the ACK; pre-ACK invalidations remain pending until that read is installed.
 */
export const observeConversation = (
    subscribe: (onEvent: (event: ConversationEvent) => void) => Promise<ConversationSubscription>,
    onReady: () => void,
    onChanged: () => void,
    onUnavailable: () => void,
    onResync: () => void,
): (() => void) => {
    let isActive = true;
    let isReady = false;
    let isPendingChange = false;
    let isResyncRequired = false;
    let handle: ConversationSubscription | null = null;
    const unsubscribe = (subscription: ConversationSubscription): void => {
        void subscription.unsubscribe().catch(() => {});
    };
    void subscribe((event) => {
        if (!isActive || isResyncRequired) return;
        if (event.kind === 'resync-required') {
            isResyncRequired = true;
            onResync();
            if (handle) unsubscribe(handle);
            return;
        }
        if (!isReady) isPendingChange = true;
        else onChanged();
    })
        .then((subscribed) => {
            if (!isActive || isResyncRequired) {
                unsubscribe(subscribed);
                return;
            }
            handle = subscribed;
            isReady = true;
            onReady();
            if (isPendingChange) onChanged();
        })
        .catch(() => {
            if (isActive && !isResyncRequired) onUnavailable();
        });
    return () => {
        isActive = false;
        if (handle) unsubscribe(handle);
    };
};

/**
 * Owns one visible Conversation observer, its serialized reads, retry timer, and polling fallback.
 */
export const startConversationReader = <Result>({
    onError,
    onResult,
    onRetry,
    read,
    subscribe,
}: {
    onError: () => void;
    onResult: (result: Result) => void;
    onRetry: () => void;
    read: () => Promise<Result>;
    subscribe?: (onEvent: (event: ConversationEvent) => void) => Promise<ConversationSubscription>;
}): (() => void) => {
    let isActive = true;
    let isReading = false;
    let isReadAgain = false;
    let eventVersion = 0;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = (): boolean => isActive;
    const hasQueuedRead = (): boolean => isReadAgain;
    const readLatest = async (): Promise<void> => {
        if (!isActive) return;
        if (isReading) {
            isReadAgain = true;
            return;
        }
        isReading = true;
        do {
            isReadAgain = false;
            try {
                // eslint-disable-next-line no-await-in-loop -- Invalidation reads must finish serially before the next snapshot.
                const result = await readConversationSnapshot(
                    read,
                    () => eventVersion,
                    () => {
                        isReadAgain = true;
                    },
                );
                if (isCurrent()) onResult(result);
            } catch {
                if (isCurrent()) onError();
            }
        } while (isCurrent() && hasQueuedRead());
        isReading = false;
    };
    const startPolling = (): void => {
        if (poll !== null) return;
        void readLatest();
        poll = setInterval(() => {
            void readLatest();
        }, 2_500);
    };
    const stopSubscription = subscribe
        ? observeConversation(
              subscribe,
              () => {
                  void readLatest();
              },
              () => {
                  eventVersion += 1;
                  void readLatest();
              },
              startPolling,
              () => {
                  eventVersion += 1;
                  startPolling();
                  retryTimer = setTimeout(onRetry, 2_500);
              },
          )
        : startPolling();
    return () => {
        isActive = false;
        stopSubscription?.();
        if (poll !== null) clearInterval(poll);
        if (retryTimer !== null) clearTimeout(retryTimer);
    };
};
