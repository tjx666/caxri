import type { ReactElement, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
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
 * One Project filter's page of the Session list. Only the current page reports scrolling and touches, restores the
 * remembered offset, and answers `activeListRef`; a page that stops being current returns to the top while it is off
 * screen, so swiping back to it starts at the top like any other Project.
 */
export const SessionListPage = ({
    empty,
    interactionRef,
    isActive,
    activeListRef,
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
    isActive: boolean;
    activeListRef: RefObject<FlashListRef<SessionListRow> | null>;
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
    const ownReference = useRef<FlashListRef<SessionListRow>>(null);
    useEffect(() => {
        if (isActive) activeListRef.current = ownReference.current;
        else ownReference.current?.scrollToOffset({ animated: false, offset: 0 });
    }, [isActive, activeListRef]);
    const [isAtTop, setIsAtTop] = useState(true);
    const isReducedMotion = useReducedMotion();
    const [shownRows, setShownRows] = useState(rows);
    const [isMoving, setIsMoving] = useState(false);
    /**
     * A Session appearing, leaving, or changing group fades and slides instead of jumping. The change lands in two
     * renders: the first arms the cells' fades while still showing the old rows (Reanimated reads `exiting` only after
     * a commit, so a row removed in the same commit would vanish), and the effect below then shows the new rows.
     * Anything else, such as a row's status or title changing in place, applies at once.
     */
    if (rows !== shownRows && !isMoving) {
        const isAnimated = shouldAnimateSessionListChange({
            isActive,
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
            ownReference.current?.prepareForLayoutAnimationRender();
            setShownRows(rows);
        });
        return () => cancelAnimationFrame(frame);
    }, [isMoving, rows, shownRows]);
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
    const active = isActive ? interactionRef : undefined;
    return (
        <View
            style={styles.list}
            onTouchCancel={() => active?.current?.touchCancel()}
            onTouchEnd={() => active?.current?.touchEnd()}
            onTouchStart={() => active?.current?.touchStart()}
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
                    onMomentumScrollBegin={() => active?.current?.momentumStart()}
                    onMomentumScrollEnd={(event) => {
                        settle(event);
                        active?.current?.momentumEnd();
                    }}
                    onLoad={isActive ? onLoad : undefined}
                    maintainVisibleContentPosition={isAtTop ? LIST_AT_TOP : undefined}
                    onScroll={isActive ? onScroll : undefined}
                    onScrollBeginDrag={() => active?.current?.dragStart()}
                    onScrollEndDrag={(event) => {
                        settle(event);
                        active?.current?.dragEnd();
                    }}
                    ref={(list) => {
                        ownReference.current = list;
                        if (isActive) activeListRef.current = list;
                    }}
                    renderItem={renderEntry}
                />
            </SessionListMotionContext>
        </View>
    );
};
