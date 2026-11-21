/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { BottomSheet, SheetTitle } from '../../../components/bottom-sheet';
import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { ConversationMessageMark } from './conversation-message-index';

/**
 * Every row is two clamped lines tall, so the list opens scrolled to the current message without measuring rows.
 */
const ROW_HEIGHT = mobileType.body.lineHeight * 2 + mobileSpace.sm * 2;

/**
 * Rows kept above the current one when the sheet opens, so the messages just before it (the usual target) are in view.
 */
const ROWS_ABOVE_CURRENT = 2;

const rowLayout = (_: ArrayLike<ConversationMessageMark> | null | undefined, index: number) => ({
    index,
    length: ROW_HEIGHT,
    offset: ROW_HEIGHT * index,
});

const markKey = (mark: ConversationMessageMark): string => mark.id;

/**
 * The phone's form of Desktop's message rail list: every user message the phone holds, oldest first, the one being read
 * marked. Tapping a row jumps there and closes the sheet. `header` is the Conversation's own load-earlier row, held
 * above the rows so a message from before the loaded pages is one tap away wherever the list is scrolled.
 */
export const ConversationMessageIndexSheet = ({
    activeIndex,
    header,
    marks,
    onClose,
    onSelect,
    theme,
}: {
    /**
     * The position in `marks` of the message being read, or `-1`.
     */
    activeIndex: number;
    header: ReactNode;
    marks: readonly ConversationMessageMark[];
    onClose: () => void;
    onSelect: (mark: ConversationMessageMark) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const renderRow = useCallback(
        (dismiss: () => void) =>
            ({ index, item }: ListRenderItemInfo<ConversationMessageMark>) => {
                const isActive = index === activeIndex;
                const label = item.preview || t('conversation.messages.attachmentsOnly');
                return (
                    <Pressable
                        accessibilityLabel={t('conversation.messages.goTo', { preview: label })}
                        accessibilityRole="button"
                        accessibilityState={{ selected: isActive }}
                        onPress={() => {
                            onSelect(item);
                            dismiss();
                        }}
                        style={({ pressed }) => [
                            styles.row,
                            {
                                backgroundColor: isActive
                                    ? theme.selection
                                    : pressed
                                      ? theme.elevated
                                      : 'transparent',
                                borderLeftColor: isActive ? theme.primary : 'transparent',
                            },
                        ]}
                        testID={`conversation-messages-row-${index}`}
                    >
                        <Text
                            numberOfLines={2}
                            style={[
                                isActive ? mobileType.bodyStrong : mobileType.body,
                                { color: item.preview ? theme.text : theme.muted },
                            ]}
                        >
                            {label}
                        </Text>
                    </Pressable>
                );
            },
        [activeIndex, onSelect, t, theme],
    );
    return (
        <BottomSheet
            closeLabel={t('conversation.messages.close')}
            maxHeight="75%"
            onClose={onClose}
            testID="conversation-messages-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <View style={styles.content}>
                    <SheetTitle
                        detail={t('conversation.messages.count', { count: marks.length })}
                        theme={theme}
                        title={t('conversation.messages.title')}
                    />
                    <View style={styles.header}>{header}</View>
                    <FlatList
                        data={marks}
                        getItemLayout={rowLayout}
                        initialScrollIndex={Math.max(activeIndex - ROWS_ABOVE_CURRENT, 0)}
                        keyExtractor={markKey}
                        renderItem={renderRow(dismiss)}
                        style={styles.list}
                    />
                </View>
            )}
        </BottomSheet>
    );
};

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */

const styles = StyleSheet.create({
    /**
     * Flexes inside the sheet's height cap so a long list scrolls instead of overflowing.
     */
    content: { flexShrink: 1 },
    list: { flexShrink: 1 },
    header: { paddingBottom: mobileSpace.xs },
    row: {
        borderLeftWidth: 3,
        borderRadius: mobileRadius.sm,
        height: ROW_HEIGHT,
        justifyContent: 'center',
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
});
