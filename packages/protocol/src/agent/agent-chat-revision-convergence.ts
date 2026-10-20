/**
 * Patches held per projection while its read is in flight. Past this many the read is simply repeated, which costs one
 * round trip instead of an unbounded queue.
 */
export const MAX_HELD_REVISION_PATCHES = 200;

/**
 * What an adapter does after feeding the core one event. Both fields are optional work, never state: the adapter
 * publishes `publish` (if present) and then starts or queues a fresh read when `reread` is set.
 */
export interface RevisionDecision<TSnapshot> {
    /**
     * A newer projection to show. Present even when `reread` is set, because patches applied before the chain broke are
     * still valid progress.
     */
    publish?: TSnapshot;
    /**
     * The revision chain cannot be trusted any more (a gap, an unreadable patch, an overflow, a reconnect): the
     * projection must be read again from Server Core instead of rendering one that silently diverged.
     */
    reread: boolean;
}

/**
 * Transport-independent revision-chain policy shared by Desktop and Mobile. It owns the hold, replay, gap, overflow,
 * reread, and dispose decisions for one revision-chained projection (a Chat or one task) and nothing else: the snapshot
 * container, the read itself, timers, subscriptions, and cache invalidation stay in the adapter.
 *
 * Protocol: a patch that arrives while a read is in flight is held, not dropped, because Server Core may have captured
 * the read just before emitting it and, if that patch is the turn's last, nothing later would reveal the gap. When the
 * read settles, held patches newer than its revision are replayed and any break in the chain asks for another read.
 */
export interface RevisionConvergence<
    TPatch extends { revision: number },
    TSnapshot extends { revision: number },
> {
    /**
     * A new read starts: patches held for an earlier read belong to a chain this read replaces, so they are dropped.
     */
    beginRead: () => void;
    /**
     * One patch arrived. `current` is the projection shown right now (`undefined` before any read); `isReading` is
     * whether a read is in flight.
     */
    receivePatch: (
        current: TSnapshot | undefined,
        patch: TPatch,
        isReading: boolean,
    ) => RevisionDecision<TSnapshot>;
    /**
     * A patch that failed validation or arrived out of a trusted channel: the chain cannot be trusted, so a fresh read
     * is required and any held patches are dropped.
     */
    receiveUntrustedPatch: () => RevisionDecision<TSnapshot>;
    /**
     * The read succeeded and `current` already contains its result. Replays held patches newer than it.
     */
    settleRead: (current: TSnapshot | undefined) => RevisionDecision<TSnapshot>;
    /**
     * The read failed or was dropped before it settled. There is nothing to replay onto, so held patches are discarded;
     * the next read starts a fresh chain.
     */
    abandonRead: () => void;
    /**
     * The transport may have dropped patches (reconnect, resync): forget held patches and require a fresh read.
     */
    reset: () => RevisionDecision<TSnapshot>;
    /**
     * Whether any patch or overflow marker is held, so an adapter can release an idle core.
     */
    hasHeld: () => boolean;
    /**
     * Ends the lifetime: held patches are released and every later call decides nothing, so nothing publishes after
     * dispose.
     */
    dispose: () => void;
}

/**
 * Whether a finished read should replace the projection shown: a read that raced behind a newer patch-built projection
 * must not move it backwards.
 */
export function shouldAdoptRead(
    current: { revision: number } | undefined,
    result: { revision: number },
): boolean {
    return !current || result.revision >= current.revision;
}

export function createRevisionConvergence<
    TPatch extends { revision: number },
    TSnapshot extends { revision: number },
>({
    apply,
    maxHeld = MAX_HELD_REVISION_PATCHES,
}: {
    /**
     * Folds a patch onto a snapshot; `undefined` means it does not continue that snapshot's revision chain.
     */
    apply: (snapshot: TSnapshot, patch: TPatch) => TSnapshot | undefined;
    maxHeld?: number;
}): RevisionConvergence<TPatch, TSnapshot> {
    let held: TPatch[] = [];
    let isOverflowed = false;
    let isDisposed = false;

    const none: RevisionDecision<TSnapshot> = { reread: false };
    const reread: RevisionDecision<TSnapshot> = { reread: true };

    const clear = (): void => {
        held = [];
        isOverflowed = false;
    };

    /**
     * Folds patches onto `base`, skipping those it already includes. A break in the chain stops the fold but keeps what
     * applied before it.
     */
    const fold = (
        base: TSnapshot | undefined,
        patches: readonly TPatch[],
    ): RevisionDecision<TSnapshot> => {
        if (patches.length === 0) return none;
        if (!base) return reread;
        let next = base;
        for (const patch of patches) {
            if (patch.revision <= next.revision) continue;
            const applied = apply(next, patch);
            if (!applied) return next === base ? reread : { publish: next, reread: true };
            next = applied;
        }
        return next === base ? none : { publish: next, reread: false };
    };

    return {
        beginRead: () => {
            clear();
        },
        receivePatch: (current, patch, isReading) => {
            if (isDisposed) return none;
            if (isReading) {
                if (isOverflowed) return none;
                if (held.length >= maxHeld) {
                    held = [];
                    isOverflowed = true;
                } else held.push(patch);
                return none;
            }
            // Nobody has read this projection: nothing to continue, and a patch must not wake a read by itself.
            if (!current) return none;
            return fold(current, [patch]);
        },
        receiveUntrustedPatch: () => {
            if (isDisposed) return none;
            clear();
            return reread;
        },
        settleRead: (current) => {
            if (isDisposed) return none;
            const patches = held;
            const overflowed = isOverflowed;
            clear();
            if (overflowed) return reread;
            return fold(current, patches);
        },
        abandonRead: clear,
        reset: () => {
            if (isDisposed) return none;
            clear();
            return reread;
        },
        hasHeld: () => held.length > 0 || isOverflowed,
        dispose: () => {
            isDisposed = true;
            clear();
        },
    };
}
