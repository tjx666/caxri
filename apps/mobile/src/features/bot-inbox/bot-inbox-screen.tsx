/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useRef } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MobileBotInboxItem } from '@caxri/protocol';
import { useRouter } from 'expo-router';

import { NoticeBanner } from '../../components/notice-banner';
import { ScreenHeader } from '../../components/screen-header';
import { ScreenState } from '../../components/screen-state';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { BotInboxCard } from './bot-inbox-card';
import type { BotInboxScreenState } from './bot-inbox-model';
import { botInboxItems, botInboxScreenState } from './bot-inbox-model';
import { useBotInbox, useBotInboxReply } from './use-bot-inbox';

const InboxStatus = ({
    onBack,
    onRetry,
    state,
    theme,
}: {
    onBack: () => void;
    onRetry: () => void;
    state: BotInboxScreenState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (state.kind === 'loading')
        return (
            <ScreenState
                kind="loading"
                testID="bot-inbox-loading"
                theme={theme}
                title={t('inbox.loading')}
            />
        );
    if (state.kind === 'offline')
        return (
            <ScreenState
                actionLabel={t('common.back')}
                kind="offline"
                onAction={onBack}
                testID="bot-inbox-offline"
                theme={theme}
                title={t('inbox.offline')}
            />
        );
    if (state.kind === 'error')
        return (
            <ScreenState
                actionLabel={t('common.retry')}
                kind="error"
                onAction={onRetry}
                testID="bot-inbox-error"
                theme={theme}
                title={t('inbox.loadFailed')}
            />
        );
    return (
        <ScreenState kind="empty" testID="bot-inbox-empty" theme={theme} title={t('inbox.empty')} />
    );
};

/**
 * The phone's "Needs you" screen: the Bot Inbox's open items, questions first, each answerable with a reply. It mirrors
 * the Desktop column of the same name in the Caxri Bot window.
 */
export const BotInboxScreen = () => {
    const { t } = useTranslation();
    const router = useRouter();
    const theme = useMobileTheme();
    const { isObservable, query, refresh } = useBotInbox();
    const reply = useBotInboxReply(refresh);
    const items = botInboxItems(query.data);
    const state = botInboxScreenState({
        hasData: query.data !== undefined,
        isError: query.isError,
        isObservable,
        itemCount: items.length,
    });
    const readAt = query.dataUpdatedAt;
    const listReference = useRef<FlatList<MobileBotInboxItem>>(null);
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
        ({ index, item }: ListRenderItemInfo<MobileBotInboxItem>) => (
            <BotInboxCard
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
            testID="bot-inbox-screen"
        >
            {/* A reply composer opens inside a card; without this the Android keyboard covers it and the Send button. */}
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.root}
            >
                <ScreenHeader
                    leading="back"
                    leadingLabel={t('inbox.back')}
                    leadingTestID="bot-inbox-back"
                    onLeading={() => router.back()}
                    theme={theme}
                    title={t('inbox.title')}
                />
                {isStale || hasRefreshError ? (
                    <NoticeBanner
                        message={t(isStale ? 'inbox.staleNotice' : 'inbox.refreshFailed')}
                        testID="bot-inbox-stale"
                        theme={theme}
                        tone={hasRefreshError ? 'danger' : 'muted'}
                    />
                ) : null}
                <FlatList
                    contentContainerStyle={styles.listContent}
                    data={items}
                    keyboardShouldPersistTaps="handled"
                    onScrollToIndexFailed={() => {}}
                    keyExtractor={(item) => item.id}
                    ListEmptyComponent={
                        <InboxStatus
                            onBack={() => router.back()}
                            onRetry={refresh}
                            state={state}
                            theme={theme}
                        />
                    }
                    ListFooterComponent={
                        query.data?.truncated ? (
                            <Text style={[styles.truncated, { color: theme.muted }]}>
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
                    testID="bot-inbox-list"
                />
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    list: { flex: 1 },
    listContent: {
        alignSelf: 'center',
        flexGrow: 1,
        gap: mobileSpace.md,
        maxWidth: 680,
        paddingBottom: mobileSpace.xl,
        paddingHorizontal: mobileSpace.md,
        paddingTop: mobileSpace.xs,
        width: '100%',
    },
    truncated: { ...mobileType.meta, padding: mobileSpace.md, textAlign: 'center' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
