import type { RefObject } from 'react';

import type { FlashListRef } from '@shopify/flash-list';

import {
    shouldFillConversationWithOlder,
    shouldReadOlderAtConversationTop,
} from './conversation-scroll';
import type { ConversationPagedTimeline } from './use-conversation-timeline';

/**
 * How the list reads older pages: `loadOlder` for the header's button, `readOlderAtTop` while the reader rests near the
 * top, and `fillWithOlder` while the rows are shorter than the viewport (`shouldFillConversationWithOlder`), so a
 * window holding only a long turn's last few rows does not open as a blank band above them. The list calls
 * `fillWithOlder` after each committed layout and once it is positioned; `isShort` tells the list whether a fill is
 * still owed, loading or not. React Compiler memoizes the functions from their ref inputs.
 *
 * A fill reads one page at a time (`isFill`). The list calls `readOlderAtTop` after every scroll event and layout
 * commit, so a reader resting at the top keeps reading until the rows move them out of the top band
 * (`shouldReadOlderAtConversationTop`).
 */
export function useConversationOlderPages<Entry>({
    isFollowing,
    isPositionedReference,
    list,
    timeline,
    viewportHeight,
}: {
    /**
     * Whether the list still follows its end, read when the list reaches its top.
     */
    isFollowing: () => boolean;
    isPositionedReference: RefObject<boolean>;
    list: RefObject<FlashListRef<Entry> | null>;
    /**
     * The latest timeline, read through a ref so the callback stays stable across renders.
     */
    timeline: RefObject<{ timeline: ConversationPagedTimeline }>;
    viewportHeight: RefObject<number>;
}): {
    fillWithOlder: () => void;
    isShort: () => boolean;
    loadOlder: () => void;
    readOlderAtTop: () => void;
} {
    const shouldFill = (isLoadingOlder: boolean): boolean => {
        const { timeline: current } = timeline.current;
        const reference = list.current;
        return (
            reference !== null &&
            shouldFillConversationWithOlder({
                contentHeight: reference.getChildContainerDimensions().height,
                // A failed page waits for the reader's Retry; reading again on every layout would loop on it.
                hasOlder: current.olderCursor !== undefined && current.error === null,
                isLoadingOlder,
                isPositioned: isPositionedReference.current,
                viewportHeight: viewportHeight.current,
            })
        );
    };
    const fillWithOlder = (): void => {
        const { timeline: current } = timeline.current;
        if (shouldFill(current.isLoadingOlder)) void current.loadOlder({ isFill: true });
    };
    const isShort = (): boolean => shouldFill(false);
    const loadOlder = (): void => {
        void timeline.current.timeline.loadOlder();
    };
    const readOlderAtTop = (): void => {
        const { timeline: current } = timeline.current;
        const reference = list.current;
        if (
            reference !== null &&
            shouldReadOlderAtConversationTop({
                hasFailed: current.error !== null,
                hasOlder: current.olderCursor !== undefined,
                isFollowing: isFollowing(),
                isLoadingOlder: current.isLoadingOlder,
                isPositioned: isPositionedReference.current,
                scrollOffset: reference.getAbsoluteLastScrollOffset(),
                viewportHeight: viewportHeight.current,
            })
        )
            void current.loadOlder();
    };
    return { fillWithOlder, isShort, loadOlder, readOlderAtTop };
}
