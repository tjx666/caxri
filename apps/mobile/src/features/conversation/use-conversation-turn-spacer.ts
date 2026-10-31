import type { RefObject } from 'react';
import { useCallback, useRef } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { useSharedValue } from 'react-native-reanimated';

import type { FlashListRef } from '@shopify/flash-list';

import {
    conversationEndOffset,
    conversationTurnSpacerHeight,
    isConversationTurnFromOlderPage,
    latestConversationTurnStart,
} from './conversation-scroll';

/**
 * Sizes the spacer after a `ConversationList`'s rows that lets the latest turn rest at the top of the viewport. React
 * Compiler memoizes the returned functions from their ref inputs.
 *
 * Two heights are kept. The end of the list is placed for the current viewport (`endSpacerHeight`), while the spacer is
 * drawn for the largest viewport the list has had, as before the keyboard opened. While the keyboard is up the drawn
 * spacer runs past the end by the keyboard's height (`spacerReserve`), so closing the keyboard grows the viewport into
 * space already there; drawing only the current viewport's spacer let Android clamp the scroll as the viewport grew,
 * which dropped the turn for a frame until the spacer grew back.
 */
export function useConversationTurnSpacer<Entry extends { id: string }>({
    bottomInset,
    isBottomAligned,
    largestViewportHeight,
    latest,
    list,
    viewportHeight,
}: {
    /**
     * The list content's bottom padding, which sits between the rows and the spacer.
     */
    bottomInset: number;
    /**
     * Whether rows shorter than the viewport sit at its bottom (`startRenderingFromBottom`), as in a list without
     * turns.
     */
    isBottomAligned: boolean;
    largestViewportHeight: RefObject<number>;
    latest: RefObject<{
        entries: readonly Entry[];
        isTurnStart: ((entry: Entry) => boolean) | undefined;
    }>;
    list: RefObject<FlashListRef<Entry> | null>;
    viewportHeight: RefObject<number>;
}): {
    endSpacerHeight: () => number;
    /**
     * Records that the reader can now see the list, so a turn whose first row lands above the rows in view stays put.
     */
    markRevealed: () => void;
    /**
     * Re-measures the spacer from the latest turn's measured rows and returns whether it changed. A row FlashList has
     * not laid out yet keeps the current spacer; the next layout commit measures again.
     */
    measureSpacer: () => boolean;
    /**
     * Scrolls to the list's end as `conversationEndOffset` places it. FlashList's own `scrollToEnd` targets the native
     * end, which while the keyboard is up lies past it by the spacer's reserve and hid a just-sent message above the
     * viewport.
     */
    scrollToLatest: (isAnimated: boolean) => void;
    spacerHeight: SharedValue<number>;
    spacerReserve: () => number;
} {
    const spacerHeight = useSharedValue(0);
    const endHeight = useRef(0);
    const drawnHeight = useRef(0);
    const isRevealed = useRef(false);
    /**
     * The first row the list held while none of its rows started a turn, and a turn the list must not lift because its
     * first row then arrived in an older page (`isConversationTurnFromOlderPage`).
     */
    const firstRowWithoutTurn = useRef<string>(undefined);
    const heldTurn = useRef<string>(undefined);
    const measureSpacer = useCallback((): boolean => {
        const { entries: rows, isTurnStart } = latest.current;
        const reference = list.current;
        if (!isTurnStart || !reference || viewportHeight.current <= 0) return false;
        const index = latestConversationTurnStart(rows, isTurnStart);
        const turnId = index === -1 ? undefined : rows[index].id;
        if (turnId === undefined) {
            if (isRevealed.current) firstRowWithoutTurn.current ??= rows[0]?.id;
        } else if (turnId !== heldTurn.current && firstRowWithoutTurn.current !== undefined) {
            if (
                isConversationTurnFromOlderPage({
                    entries: rows,
                    firstRowWithoutTurn: firstRowWithoutTurn.current,
                    turnStart: index,
                })
            )
                heldTurn.current = turnId;
            firstRowWithoutTurn.current = undefined;
        }
        let height = 0;
        let drawn = 0;
        if (turnId !== undefined && turnId !== heldTurn.current) {
            const layout = reference.getLayout(index);
            if (!layout) return false;
            const turn = {
                bottomInset,
                contentHeight: reference.getChildContainerDimensions().height,
                turnTop: layout.y,
            };
            height = conversationTurnSpacerHeight({
                ...turn,
                viewportHeight: viewportHeight.current,
            });
            drawn = conversationTurnSpacerHeight({
                ...turn,
                viewportHeight: largestViewportHeight.current,
            });
        }
        if (height === endHeight.current && drawn === drawnHeight.current) return false;
        endHeight.current = height;
        drawnHeight.current = drawn;
        spacerHeight.set(drawn);
        return true;
    }, [bottomInset, largestViewportHeight, latest, list, spacerHeight, viewportHeight]);
    const scrollToLatest = useCallback(
        (isAnimated: boolean): void => {
            const reference = list.current;
            if (!reference || viewportHeight.current <= 0) return;
            reference.scrollToOffset({
                animated: isAnimated,
                offset: conversationEndOffset({
                    bottomInset,
                    contentHeight: reference.getChildContainerDimensions().height,
                    firstItemOffset: reference.getFirstItemOffset(),
                    isBottomAligned,
                    spacerHeight: endHeight.current,
                    viewportHeight: viewportHeight.current,
                }),
            });
        },
        [bottomInset, isBottomAligned, list, viewportHeight],
    );
    return {
        endSpacerHeight: () => endHeight.current,
        markRevealed: () => {
            isRevealed.current = true;
        },
        measureSpacer,
        scrollToLatest,
        spacerHeight,
        spacerReserve: () => drawnHeight.current - endHeight.current,
    };
}
