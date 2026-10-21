/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useRef } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import {
    ActivityIndicator,
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MobileCommanderInboxItem } from '@caxri/protocol';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { CommanderInboxCard } from './commander-inbox-card';
import type { CommanderInboxScreenState } from './commander-inbox-model';
import { commanderInboxItems, commanderInboxScreenState } from './commander-inbox-model';
import { useCommanderInbox, useCommanderInboxReply } from './use-commander-inbox';

const InboxStatus = ({
    onRetry,
    state,
    theme,
}: {
    onRetry: () => void;
    state: CommanderInboxScreenState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (state.kind === 'loading')
        return (
            <View style={styles.status} testID="commander-inbox-loading">
                <ActivityIndicator color={theme.primary} />
            </View>
        );
    const message = t(
        state.kind === 'offline'
            ? 'inbox.offline'
            : state.kind === 'error'
              ? 'inbox.loadFailed'
              : 'inbox.empty',
    );
    return (
        <View style={styles.status} testID={`commander-inbox-${state.kind}`}>
            <Text
                accessibilityRole={state.kind === 'error' ? 'alert' : undefined}
                style={[
                    styles.statusText,
                    { color: state.kind === 'error' ? theme.danger : theme.muted },
                ]}
            >
                {message}
            </Text>
            {state.kind === 'error' ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={onRetry}
                    style={[styles.retry, { borderColor: theme.border }]}
                    testID="commander-inbox-retry"
                >
                    <Text style={[styles.retryText, { color: theme.primary }]}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};

/**
 * The phone's "Needs you" screen: the Commander Inbox's open items, questions first, each answerable with a reply. It
 * mirrors the Desktop column of the same name in the Agent Commander window.
 */
export const CommanderInboxScreen = () => {
    const { t } = useTranslation();
    const router = useRouter();
    const theme = useMobileTheme();
    const { isObservable, query, refresh } = useCommanderInbox();
    const reply = useCommanderInboxReply(refresh);
    const items = commanderInboxItems(query.data);
    const state = commanderInboxScreenState({
        hasData: query.data !== undefined,
        isError: query.isError,
        isObservable,
        itemCount: items.length,
    });
    const readAt = query.dataUpdatedAt;
    const listReference = useRef<FlatList<MobileCommanderInboxItem>>(null);
    const composingIndex = useRef<number | undefined>(undefined);
    /**
     * Android scrolls only the focused input into view, which leaves Send under the keyboard. When the keyboard opens,
     * the list shrinks; after that layout, align the composing card's bottom (its Send button) with the list's bottom.
     * Scrolling on `keyboardDidShow` instead would measure the list before it shrinks.
     */
    const revealComposer = useCallback(() => {
        const index = composingIndex.current;
        if (index !== undefined && Keyboard.isVisible())
            listReference.current?.scrollToIndex({ animated: true, index, viewPosition: 1 });
    }, []);
    const renderItem = useCallback(
        ({ index, item }: ListRenderItemInfo<MobileCommanderInboxItem>) => (
            <CommanderInboxCard
                error={reply.error?.itemId === item.id ? reply.error.message : undefined}
                isSending={reply.pendingId === item.id}
                item={item}
                onComposerFocus={() => {
                    composingIndex.current = index;
                }}
                onSend={reply.send}
                readAt={readAt}
                theme={theme}
            />
        ),
        [readAt, reply.error, reply.pendingId, reply.send, theme],
    );
    const isStale = 'isStale' in state && state.isStale;
    const hasRefreshError = 'hasRefreshError' in state && state.hasRefreshError;
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="commander-inbox-screen"
        >
            {/* A reply composer opens inside a card; without this the Android keyboard covers it and the Send button. */}
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.root}
            >
                <View style={styles.header}>
                    <IconButton
                        accessibilityLabel={t('inbox.back')}
                        icon={ChevronLeft}
                        onPress={() => router.back()}
                        size={24}
                        testID="commander-inbox-back"
                        theme={theme}
                    />
                    <Text
                        accessibilityRole="header"
                        style={[styles.heading, { color: theme.text }]}
                    >
                        {t('inbox.title')}
                    </Text>
                </View>
                {isStale || hasRefreshError ? (
                    <Text
                        accessibilityRole={hasRefreshError ? 'alert' : undefined}
                        style={[
                            styles.banner,
                            {
                                borderColor: theme.border,
                                color: hasRefreshError ? theme.danger : theme.muted,
                            },
                        ]}
                        testID="commander-inbox-stale"
                    >
                        {t(isStale ? 'inbox.staleNotice' : 'inbox.refreshFailed')}
                    </Text>
                ) : null}
                <FlatList
                    contentContainerStyle={styles.listContent}
                    data={items}
                    keyboardShouldPersistTaps="handled"
                    onScrollToIndexFailed={() => {}}
                    keyExtractor={(item) => item.id}
                    ListEmptyComponent={
                        <InboxStatus onRetry={refresh} state={state} theme={theme} />
                    }
                    ListFooterComponent={
                        query.data?.truncated ? (
                            <Text style={[styles.statusText, { color: theme.muted }]}>
                                {t('inbox.truncated', {
                                    shown: items.length,
                                    total: query.data.total,
                                })}
                            </Text>
                        ) : undefined
                    }
                    onRefresh={refresh}
                    refreshing={isObservable && query.isRefetching}
                    onLayout={revealComposer}
                    ref={listReference}
                    renderItem={renderItem}
                    style={styles.list}
                    testID="commander-inbox-list"
                />
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: { alignItems: 'center', flexDirection: 'row', minHeight: 60, paddingHorizontal: 6 },
    heading: { fontSize: 20, fontWeight: '700', marginLeft: 6 },
    banner: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        fontSize: 13,
        paddingBottom: 8,
        paddingHorizontal: 20,
    },
    list: { flex: 1 },
    listContent: {
        alignSelf: 'center',
        gap: 12,
        maxWidth: 680,
        paddingBottom: 24,
        paddingHorizontal: 12,
        paddingTop: 4,
        width: '100%',
    },
    status: { alignItems: 'center', gap: 12, padding: 32 },
    statusText: { fontSize: 14, padding: 12, textAlign: 'center' },
    retry: {
        alignItems: 'center',
        borderRadius: 18,
        borderWidth: 1,
        justifyContent: 'center',
        minHeight: 36,
        paddingHorizontal: 16,
    },
    retryText: { fontSize: 14, fontWeight: '700' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
