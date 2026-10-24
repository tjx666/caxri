import type { RefObject } from 'react';

import type { FlashListRef } from '@shopify/flash-list';

import { shouldFillConversationWithOlder } from './conversation-scroll';
import type { ConversationTimelineState } from './use-conversation-timeline';

/**
 * How the list reads older pages: `loadOlder` for the header's button, `onStartReached` when the reader scrolls near
 * the top, and `fillWithOlder` while the rows are shorter than the viewport (`shouldFillConversationWithOlder`), so a
 * window holding only a long turn's last few rows does not open as a blank band above them. The list calls
 * `fillWithOlder` after each committed layout and once it is positioned. React Compiler memoizes the functions from
 * their ref inputs.
 */
export function useConversationOlderPages<Entry>({
    isPositionedReference,
    list,
    timeline,
    viewportHeight,
}: {
    isPositionedReference: RefObject<boolean>;
    list: RefObject<FlashListRef<Entry> | null>;
    /**
     * The latest timeline, read through a ref so the callback stays stable across renders.
     */
    timeline: RefObject<{
        timeline: ConversationTimelineState & { loadOlder: () => Promise<void> };
    }>;
    viewportHeight: RefObject<number>;
}): { fillWithOlder: () => void; loadOlder: () => void; onStartReached: () => void } {
    const fillWithOlder = (): void => {
        const { timeline: current } = timeline.current;
        const reference = list.current;
        if (
            !reference ||
            !shouldFillConversationWithOlder({
                contentHeight: reference.getChildContainerDimensions().height,
                // A failed page waits for the reader's Retry; reading again on every layout would loop on it.
                hasOlder: current.olderCursor !== undefined && current.error === null,
                isLoadingOlder: current.isLoadingOlder,
                isPositioned: isPositionedReference.current,
                viewportHeight: viewportHeight.current,
            })
        )
            return;
        void current.loadOlder();
    };
    const loadOlder = (): void => {
        void timeline.current.timeline.loadOlder();
    };
    const onStartReached = (): void => {
        const { timeline: current } = timeline.current;
        if (isPositionedReference.current && current.olderCursor && !current.isLoadingOlder) {
            void current.loadOlder();
        }
    };
    return { fillWithOlder, loadOlder, onStartReached };
}
