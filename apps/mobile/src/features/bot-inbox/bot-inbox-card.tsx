/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { MobileBotInboxItem } from '@caxri/protocol';
import { ExternalLink, MessageSquareReply } from 'lucide-react-native';

import { Button } from '../../components/button';
import { Card } from '../../components/card';
import { Chip } from '../../components/chip';
import { useTranslation } from '../../i18n';
import { openLink } from '../../lib/open-link';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from '../conversation/conversation-markdown';
import { botInboxCardModel, botInboxReplyBody } from './bot-inbox-model';

/**
 * One open Inbox item, laid out like the Desktop "Needs you" card: title and age, kind and pull request, the Caxri
 * Bot's Markdown, numbered options, and the owner's replies with their read state. Reply opens a composer in place;
 * Merge and Dismiss stay on Desktop.
 */
export const BotInboxCard = ({
    error,
    isSending,
    item,
    onComposerFocus,
    onSend,
    readAt,
    theme,
}: {
    error: string | undefined;
    isSending: boolean;
    item: MobileBotInboxItem;
    /**
     * Lets the list bring the whole composer, Send included, above the keyboard once it opens.
     */
    onComposerFocus: () => void;
    onSend: (itemId: string, body: string) => Promise<boolean>;
    readAt: number;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isComposing, setComposing] = useState(false);
    const model = botInboxCardModel(item, readAt, t);
    const pullRequestUrl = item.pullRequest?.url;
    return (
        <Card testID={`bot-inbox-item-${item.id}`} theme={theme}>
            <View style={styles.titleRow}>
                <Text style={[styles.title, { color: theme.text }]}>{item.title}</Text>
                <Text style={[styles.meta, { color: theme.muted }]}>{model.ageLabel}</Text>
            </View>
            <View style={styles.metaRow}>
                <Text style={[styles.meta, { color: theme.muted }]}>{model.kindLabel}</Text>
                {pullRequestUrl && model.pullRequestLabel ? (
                    <Pressable
                        accessibilityHint={t('inbox.openPullRequestHint')}
                        accessibilityRole="link"
                        hitSlop={8}
                        onPress={() => openLink(pullRequestUrl)}
                        style={styles.link}
                    >
                        <Text style={[styles.meta, { color: theme.primary }]}>
                            {`· ${model.pullRequestLabel}`}
                        </Text>
                        <ExternalLink color={theme.primary} size={12} />
                    </Pressable>
                ) : null}
                {model.staleLabel ? (
                    <Text style={[styles.meta, { color: theme.warning }]}>
                        {`· ${model.staleLabel}`}
                    </Text>
                ) : null}
            </View>
            {item.body ? <ConversationMarkdown text={item.body} theme={theme} /> : null}
            {item.isBodyClipped ? (
                <Text style={[styles.meta, { color: theme.muted }]}>{t('inbox.bodyClipped')}</Text>
            ) : null}
            {item.options.length > 0 ? (
                <View style={styles.options}>
                    {item.options.map((option, index) => (
                        <Text key={option} style={[styles.option, { color: theme.text }]}>
                            {`${index + 1}. ${option}`}
                        </Text>
                    ))}
                </View>
            ) : null}
            {item.replies.length > 0 ? (
                <BotInboxReplies item={item} replyState={model.replyState} theme={theme} />
            ) : null}
            {isComposing ? (
                <BotInboxReplyComposer
                    error={error}
                    isSending={isSending}
                    item={item}
                    onClose={() => setComposing(false)}
                    onComposerFocus={onComposerFocus}
                    onSend={onSend}
                    theme={theme}
                />
            ) : (
                <View style={styles.replyChip}>
                    <Chip
                        icon={MessageSquareReply}
                        label={t('inbox.reply')}
                        onPress={() => setComposing(true)}
                        testID={`bot-inbox-reply-${item.id}`}
                        theme={theme}
                        tint={theme.primary}
                    />
                </View>
            )}
        </Card>
    );
};

/**
 * The owner's replies on one card, with Caxri Bot's read state under the latest.
 */
const BotInboxReplies = ({
    item,
    replyState,
    theme,
}: {
    item: MobileBotInboxItem;
    replyState: ReturnType<typeof botInboxCardModel>['replyState'];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={[styles.replies, { borderColor: theme.border }]}>
            {item.earlierReplyCount > 0 ? (
                <Text style={[styles.meta, { color: theme.muted }]}>
                    {t(
                        item.earlierReplyCount === 1
                            ? 'inbox.earlierRepliesOne'
                            : 'inbox.earlierRepliesOther',
                        { count: item.earlierReplyCount },
                    )}
                </Text>
            ) : null}
            {item.replies.map((reply) => (
                <Text key={reply.sequence} style={[styles.reply, { color: theme.text }]}>
                    {reply.body}
                </Text>
            ))}
            {replyState ? (
                <Text
                    style={[
                        styles.meta,
                        { color: replyState.isRead ? theme.success : theme.muted },
                    ]}
                    testID={`bot-inbox-reply-state-${item.id}`}
                >
                    {replyState.label}
                </Text>
            ) : null}
        </View>
    );
};

/**
 * The in-place reply composer of one card. It owns the draft, so Cancel discards it.
 */
const BotInboxReplyComposer = ({
    error,
    isSending,
    item,
    onClose,
    onComposerFocus,
    onSend,
    theme,
}: {
    error: string | undefined;
    isSending: boolean;
    item: MobileBotInboxItem;
    onClose: () => void;
    onComposerFocus: () => void;
    onSend: (itemId: string, body: string) => Promise<boolean>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const body = botInboxReplyBody(draft);
    const send = async (): Promise<void> => {
        if (body && (await onSend(item.id, body))) onClose();
    };
    return (
        <View style={styles.composer}>
            <TextInput
                accessibilityLabel={t('inbox.replyTo', { title: item.title })}
                autoFocus
                editable={!isSending}
                multiline
                onChangeText={setDraft}
                onFocus={onComposerFocus}
                placeholder={t('inbox.replyPlaceholder')}
                placeholderTextColor={theme.muted}
                style={[
                    styles.input,
                    {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                        color: theme.text,
                    },
                ]}
                testID={`bot-inbox-reply-input-${item.id}`}
                value={draft}
            />
            {error ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.meta, { color: theme.danger }]}
                    testID={`bot-inbox-reply-error-${item.id}`}
                >
                    {error}
                </Text>
            ) : null}
            <View style={styles.actions}>
                <Button
                    isDisabled={isSending}
                    label={t('common.cancel')}
                    onPress={onClose}
                    style={styles.action}
                    testID={`bot-inbox-reply-cancel-${item.id}`}
                    theme={theme}
                    variant="outline"
                />
                <Button
                    isBusy={isSending}
                    isDisabled={!body}
                    label={t('inbox.send')}
                    onPress={() => {
                        void send();
                    }}
                    style={styles.action}
                    testID={`bot-inbox-reply-send-${item.id}`}
                    theme={theme}
                    variant="primary"
                />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    titleRow: { alignItems: 'baseline', flexDirection: 'row', gap: mobileSpace.sm },
    title: { ...mobileType.bodyStrong, flex: 1 },
    metaRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: mobileSpace.sm },
    meta: mobileType.meta,
    link: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.xs },
    options: { gap: mobileSpace.xs },
    option: mobileType.body,
    replies: { borderLeftWidth: 2, gap: mobileSpace.sm, paddingLeft: mobileSpace.md },
    reply: mobileType.body,
    composer: { gap: mobileSpace.sm },
    input: {
        ...mobileType.body,
        borderRadius: mobileRadius.sm,
        borderWidth: 1,
        maxHeight: 160,
        minHeight: 72,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.md,
        textAlignVertical: 'top',
    },
    actions: { flexDirection: 'row', gap: mobileSpace.sm, justifyContent: 'flex-end' },
    action: { minWidth: 96 },
    replyChip: { alignItems: 'flex-start' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
