import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { Archive } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import type { SwipeRow } from '../open-swipe-row';

const ACTION_WIDTH = 84;

const styles = StyleSheet.create({
    action: {
        alignItems: 'center',
        borderRadius: 14,
        gap: 4,
        justifyContent: 'center',
        marginLeft: 6,
        marginRight: 8,
        width: ACTION_WIDTH,
    },
    actionText: { fontSize: 13, fontWeight: '700' },
});

/**
 * A Session row that reveals Archive when swiped left, like a chat list's delete action. Only one row stays open at a
 * time: the row reports when a drag toward opening starts, when it opens, and when it closes or unmounts, and the list
 * closes the previous row as soon as another one starts to open.
 */
export const SessionSwipeRow = ({
    busy,
    children,
    enabled,
    onArchive,
    onClose,
    onOpen,
    onOpenStart,
    sessionId,
    theme,
}: {
    busy: boolean;
    children: ReactNode;
    /**
     * Only a control device may archive, so other roles get a plain row that ignores horizontal drags.
     */
    enabled: boolean;
    onArchive: (sessionId: string) => Promise<boolean>;
    onClose: (row: SwipeRow) => void;
    onOpen: (row: SwipeRow) => void;
    onOpenStart: (row: SwipeRow) => void;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const swipeableReference = useRef<SwipeableMethods>(null);
    const handleOpenStart = useCallback((): void => {
        if (swipeableReference.current) onOpenStart(swipeableReference.current);
    }, [onOpenStart]);
    const handleOpen = useCallback((): void => {
        if (swipeableReference.current) onOpen(swipeableReference.current);
    }, [onOpen]);
    const handleClose = useCallback((): void => {
        if (swipeableReference.current) onClose(swipeableReference.current);
    }, [onClose]);
    useEffect(() => {
        const row = swipeableReference.current;
        // An archived or recycled row unmounts without a close event, so it reports itself closed.
        return () => {
            if (row) onClose(row);
        };
    }, [onClose]);
    const archive = useCallback(async (): Promise<void> => {
        const done = await onArchive(sessionId);
        // A successful archive removes the row; a failed one closes so the list error stays in view.
        if (!done) swipeableReference.current?.close();
    }, [onArchive, sessionId]);
    const renderRightActions = useCallback(
        () => (
            <Pressable
                accessibilityLabel="Archive Session"
                accessibilityRole="button"
                accessibilityState={{ busy, disabled: busy }}
                disabled={busy}
                onPress={archive}
                style={({ pressed }) => [
                    styles.action,
                    { backgroundColor: theme.danger, opacity: pressed ? 0.8 : 1 },
                ]}
                testID={`session-swipe-archive-${sessionId}`}
            >
                {busy ? (
                    <ActivityIndicator color={theme.primaryForeground} />
                ) : (
                    <>
                        <Archive color={theme.primaryForeground} size={20} strokeWidth={2.25} />
                        <Text style={[styles.actionText, { color: theme.primaryForeground }]}>
                            Archive
                        </Text>
                    </>
                )}
            </Pressable>
        ),
        [archive, busy, sessionId, theme],
    );
    return (
        <ReanimatedSwipeable
            childrenContainerStyle={{ backgroundColor: theme.background }}
            enabled={enabled}
            friction={1.5}
            onSwipeableClose={handleClose}
            onSwipeableOpenStartDrag={handleOpenStart}
            onSwipeableWillOpen={handleOpen}
            overshootRight={false}
            ref={swipeableReference}
            renderRightActions={renderRightActions}
            rightThreshold={ACTION_WIDTH / 2}
        >
            {children}
        </ReanimatedSwipeable>
    );
};
