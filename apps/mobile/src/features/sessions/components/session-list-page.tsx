import type { ReactElement, RefObject } from 'react';
import { useEffect, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';

import type { SessionListRow } from '../session-list-groups';
import type { createSessionListInteraction } from '../session-list-interaction';
import {
    SESSION_LIST_MOTION_MS,
    SessionListMotionContext,
    sessionListRowOrder,
    shouldAnimateSessionListChange,
} from '../session-list-motion';
import { SessionListCell } from './session-list-cell';

const styles = StyleSheet.create({ list: { flex: 1 } });

const entryKey = (entry: SessionListRow): string => entry.id;

/**
 * How far from the top, in dp, the list still counts as resting at the top.
 */
const TOP_REST_THRESHOLD = 4;

/**
 * FlashList keeps the first visible row in place when rows are inserted above it. Sessions move between status groups
 * all the time, so at the top that anchor pushes a newly shown Needs attention heading and its Session above the
 * viewport, exactly what this list exists to show first. The anchor stays on only once the user has scrolled away from
 * the top, where it keeps the row they are reading from jumping.
 */
const LIST_AT_TOP = { disabled: true } as const;

const entryType = (entry: SessionListRow): SessionListRow['type'] => entry.type;

/**
 * The Session list for the chosen Project filter: it reports scrolling and touches to the list interaction, restores
 * the remembered offset, and animates rows that appear, leave, or change group.
 */
export const SessionListPage = ({
    empty,
    interactionRef,
    listRef,
    motionScope,
    bottomInset = 0,
    onLoad,
    onScroll,
    renderEntry,
    rows,
}: {
    /**
     * The empty or loading state shown instead of the list when the page has no rows.
     */
    empty: ReactElement | null;
    interactionRef: RefObject<ReturnType<typeof createSessionListInteraction> | null>;
    listRef: RefObject<FlashListRef<SessionListRow> | null>;
    /**
     * Which list the rows belong to (see `sessionListMotionScope`). Rows animate only while it stays the same.
     */
    motionScope: string;
    /**
     * Space kept below the last row so a control floating over the list (the phone's New Session button) never covers
     * its trailing glyph or pull request chip.
     */
    bottomInset?: number;
    onLoad: () => void;
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    renderEntry: (info: ListRenderItemInfo<SessionListRow>) => ReactElement;
    rows: SessionListRow[];
}) => {
    const [isAtTop, setIsAtTop] = useState(true);
    const isReducedMotion = useReducedMotion();
    const [shownRows, setShownRows] = useState(rows);
    const [shownScope, setShownScope] = useState(motionScope);
    const [isMoving, setIsMoving] = useState(false);
    /**
     * Rows for another scope replace the list at once, cancelling any motion still running for the old one, so choosing
     * a Project never reads as its Sessions arriving.
     */
    if (motionScope !== shownScope) {
        setShownScope(motionScope);
        setShownRows(rows);
        setIsMoving(false);
    } else if (rows !== shownRows && !isMoving) {
        /**
         * A Session appearing, leaving, or changing group fades and slides instead of jumping. The change lands in two
         * renders: the first arms the cells' fades while still showing the old rows (Reanimated reads `exiting` only
         * after a commit, so a row removed in the same commit would vanish), and the effect below then shows the new
         * rows. Anything else, such as a row's status or title changing in place, applies at once.
         */
        const isAnimated = shouldAnimateSessionListChange({
            isReducedMotion,
            nextOrder: sessionListRowOrder(rows),
            previousOrder: sessionListRowOrder(shownRows),
        });
        if (isAnimated) setIsMoving(true);
        else setShownRows(rows);
    }
    useEffect(() => {
        if (!isMoving || rows === shownRows) return;
        // A frame later, so the transitions armed by the last commit have reached the UI thread. Recycling stays off for
        // this render, so a removed row's cell unmounts (and fades) instead of being reused for its neighbour;
        // FlashList turns it back on after the commit.
        const frame = requestAnimationFrame(() => {
            listRef.current?.prepareForLayoutAnimationRender();
            setShownRows(rows);
        });
        return () => cancelAnimationFrame(frame);
    }, [isMoving, listRef, rows, shownRows]);
    useEffect(() => {
        if (!isMoving || rows !== shownRows) return;
        const settle = setTimeout(() => setIsMoving(false), SESSION_LIST_MOTION_MS + 60);
        return () => clearTimeout(settle);
    }, [isMoving, rows, shownRows]);
    if (empty) return empty;
    /**
     * Read where a scroll comes to rest rather than on every frame, so scrolling never re-renders the list.
     */
    const settle = (event: NativeSyntheticEvent<NativeScrollEvent>): void =>
        setIsAtTop(event.nativeEvent.contentOffset.y <= TOP_REST_THRESHOLD);
    return (
        <View
            style={styles.list}
            onTouchCancel={() => interactionRef.current?.touchCancel()}
            onTouchEnd={() => interactionRef.current?.touchEnd()}
            onTouchStart={() => interactionRef.current?.touchStart()}
        >
            <SessionListMotionContext value={isMoving}>
                <FlashList
                    ListFooterComponent={
                        bottomInset > 0 ? <View style={{ height: bottomInset }} /> : null
                    }
                    CellRendererComponent={SessionListCell}
                    data={shownRows}
                    getItemType={entryType}
                    keyExtractor={entryKey}
                    onMomentumScrollBegin={() => interactionRef.current?.momentumStart()}
                    onMomentumScrollEnd={(event) => {
                        settle(event);
                        interactionRef.current?.momentumEnd();
                    }}
                    onLoad={onLoad}
                    maintainVisibleContentPosition={isAtTop ? LIST_AT_TOP : undefined}
                    onScroll={onScroll}
                    onScrollBeginDrag={() => interactionRef.current?.dragStart()}
                    onScrollEndDrag={(event) => {
                        settle(event);
                        interactionRef.current?.dragEnd();
                    }}
                    ref={listRef}
                    renderItem={renderEntry}
                />
            </SessionListMotionContext>
        </View>
    );
};
