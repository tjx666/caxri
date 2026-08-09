export type WorkTabMotionPhase = 'enter' | 'exit' | 'stable';

export interface WorkTabMotionItem<Item extends { motionKey: string }> {
    item: Item;
    phase: WorkTabMotionPhase;
}

/**
 * Reconciles live tabs with short-lived exit snapshots. The Runtime/editor stores remain the
 * authority for whether a tab exists; this list only keeps a removed visual inert until its exit
 * keyframe completes, so confirmation or persistence behavior is never delayed by animation.
 */
export function reconcileWorkTabMotion<Item extends { motionKey: string }>(
    current: WorkTabMotionItem<Item>[],
    next: Item[],
    animate: boolean,
): WorkTabMotionItem<Item>[] {
    if (!animate) return next.map((item) => ({ item, phase: 'stable' }));

    const currentByKey = new Map(current.map((entry) => [entry.item.motionKey, entry]));
    const nextKeys = new Set(next.map((item) => item.motionKey));
    const result = next.map((item): WorkTabMotionItem<Item> => {
        const previous = currentByKey.get(item.motionKey);
        return {
            item,
            phase: previous?.phase === 'enter' ? 'enter' : previous ? 'stable' : 'enter',
        };
    });

    for (const [currentIndex, entry] of current.entries()) {
        if (nextKeys.has(entry.item.motionKey)) continue;
        const exiting = { ...entry, phase: 'exit' as const };
        const followingKey = current
            .slice(currentIndex + 1)
            .find((candidate) =>
                result.some((item) => item.item.motionKey === candidate.item.motionKey),
            )?.item.motionKey;
        if (followingKey) {
            result.splice(
                result.findIndex((item) => item.item.motionKey === followingKey),
                0,
                exiting,
            );
            continue;
        }
        const precedingKey = current
            .slice(0, currentIndex)
            .toReversed()
            .find((candidate) =>
                result.some((item) => item.item.motionKey === candidate.item.motionKey),
            )?.item.motionKey;
        const precedingIndex = precedingKey
            ? result.findIndex((item) => item.item.motionKey === precedingKey)
            : -1;
        result.splice(precedingIndex + 1, 0, exiting);
    }
    return result;
}

/** Settles an entry keyframe or removes the inert snapshot left by an exit keyframe. */
export function finishWorkTabMotion<Item extends { motionKey: string }>(
    current: WorkTabMotionItem<Item>[],
    motionKey: string,
): WorkTabMotionItem<Item>[] {
    return current.flatMap((entry) => {
        if (entry.item.motionKey !== motionKey) return [entry];
        if (entry.phase === 'exit') return [];
        return [{ ...entry, phase: 'stable' }];
    });
}
