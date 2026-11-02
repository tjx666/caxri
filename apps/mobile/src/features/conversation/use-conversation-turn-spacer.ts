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
 * How long a disclosure's reserve waits for the rows to change height before it is dropped.
 */
const DISCLOSURE_RESERVE_MS = 1000;

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
     * Grows the drawn spacer by the rows' height before the reader opens or closes a row in the latest turn. Closing a
     * row shrank the native content before JS re-measured the spacer, so Android clamped the scroll and the previous
     * turn flashed into view until the spacer grew back. The reserve lasts until the rows are measured at another
     * height, or `DISCLOSURE_RESERVE_MS` when the toggle left their height alone.
     */
    reserveForDisclosure: () => void;
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
    /**
     * The rows' height when the reader opened or closed a row, while the drawn spacer still carries the room reserved
     * for it (`reserveForDisclosure`); cleared once the rows were measured at another height.
     */
    const disclosedRowsHeight = useRef<number>(undefined);
    const disclosureReserve = useRef(0);
    /**
     * Counts reserve releases, so a release that a later one superseded does not draw its stale height.
     */
    const releaseCount = useRef(0);
    /**
     * Draws the measured spacer once the rows' new height reached the screen. FlashList commits the rows' height
     * natively in the same layout pass that measured it, while a shared value reaches the UI thread a frame later;
     * dropping the reserve in that pass still let Android clamp the scroll for a frame.
     */
    const releaseReserve = useCallback((): void => {
        releaseCount.current += 1;
        const release = releaseCount.current;
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                if (release !== releaseCount.current) return;
                disclosureReserve.current = 0;
                console.log('WGDBG release', Date.now(), drawnHeight.current);
                spacerHeight.set(Math.max(drawnHeight.current, 0));
            }),
        );
    }, [spacerHeight]);
    const measureSpacer = useCallback((): boolean => {
        const { entries: rows, isTurnStart } = latest.current;
        const reference = list.current;
        if (!isTurnStart || !reference || viewportHeight.current <= 0) return false;
        let isReleasing = false;
        if (disclosedRowsHeight.current !== undefined) {
            // The toggled row has not been measured yet; the reserved room stays until it has.
            if (reference.getChildContainerDimensions().height === disclosedRowsHeight.current)
                return false;
            console.log('WGDBG measured', Date.now(), reference.getChildContainerDimensions().height);
            disclosedRowsHeight.current = undefined;
            isReleasing = true;
        }
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
            if (!layout) {
                if (isReleasing) releaseReserve();
                return false;
            }
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
        if (isReleasing || disclosureReserve.current > 0) {
            console.log('WGDBG drawn', Date.now(), height, drawn);
            // Keep the reserve on screen until the shrunk rows are; the release draws the measured spacer.
            endHeight.current = height;
            drawnHeight.current = drawn;
            releaseReserve();
            return true;
        }
        if (height === endHeight.current && drawn === drawnHeight.current) return false;
        endHeight.current = height;
        drawnHeight.current = drawn;
        spacerHeight.set(drawn);
        return true;
    }, [
        bottomInset,
        largestViewportHeight,
        latest,
        list,
        releaseReserve,
        spacerHeight,
        viewportHeight,
    ]);
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
    const reserveForDisclosure = useCallback((): void => {
        const reference = list.current;
        if (!reference || !latest.current.isTurnStart) return;
        const rowsHeight = reference.getChildContainerDimensions().height;
        disclosedRowsHeight.current = rowsHeight;
        // However far the row shrinks, the rows and spacer together never get shorter than they were.
        disclosureReserve.current = rowsHeight;
        console.log('WGDBG reserve', Date.now(), rowsHeight, drawnHeight.current, endHeight.current);
        spacerHeight.set(Math.max(drawnHeight.current, 0) + rowsHeight);
        // A toggle that leaves the rows' height alone never triggers the measurement that ends the reserve.
        setTimeout(() => {
            if (disclosedRowsHeight.current !== rowsHeight) return;
            disclosedRowsHeight.current = undefined;
            disclosureReserve.current = 0;
            spacerHeight.set(Math.max(drawnHeight.current, 0));
        }, DISCLOSURE_RESERVE_MS);
    }, [latest, list, spacerHeight]);
    return {
        endSpacerHeight: () => endHeight.current,
        markRevealed: () => {
            isRevealed.current = true;
        },
        measureSpacer,
        reserveForDisclosure,
        scrollToLatest,
        spacerHeight,
        spacerReserve: () =>
            Math.max(drawnHeight.current, 0) + disclosureReserve.current - endHeight.current,
    };
}
