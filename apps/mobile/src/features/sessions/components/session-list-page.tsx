import type { ReactElement, RefObject } from 'react';
import { useEffect, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { StyleSheet, View } from 'react-native';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';

import type { SessionListRow } from '../session-list-groups';
import type { createSessionListInteraction } from '../session-list-interaction';

const styles = StyleSheet.create({ list: { flex: 1 } });

const entryKey = (entry: SessionListRow): string => entry.id;
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
    if (empty) return empty;
    const active = isActive ? interactionRef : undefined;
    return (
        <View
            style={styles.list}
            onTouchCancel={() => active?.current?.touchCancel()}
            onTouchEnd={() => active?.current?.touchEnd()}
            onTouchStart={() => active?.current?.touchStart()}
        >
            <FlashList
                ListFooterComponent={
                    bottomInset > 0 ? <View style={{ height: bottomInset }} /> : null
                }
                data={rows}
                getItemType={entryType}
                keyExtractor={entryKey}
                onMomentumScrollBegin={() => active?.current?.momentumStart()}
                onMomentumScrollEnd={() => active?.current?.momentumEnd()}
                onLoad={isActive ? onLoad : undefined}
                onScroll={isActive ? onScroll : undefined}
                onScrollBeginDrag={() => active?.current?.dragStart()}
                onScrollEndDrag={() => active?.current?.dragEnd()}
                ref={(list) => {
                    ownReference.current = list;
                    if (isActive) activeListRef.current = list;
                }}
                renderItem={renderEntry}
            />
        </View>
    );
};
