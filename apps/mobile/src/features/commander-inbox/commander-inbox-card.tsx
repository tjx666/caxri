/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { MobileCommanderInboxItem } from '@caxri/protocol';
import { ExternalLink, MessageSquareReply } from 'lucide-react-native';

import { openExternalLink } from '../../lib/open-external-link';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from '../conversation/conversation-markdown';
import { commanderInboxCardModel, commanderInboxReplyBody } from './commander-inbox-model';

/**
 * One open Inbox item, laid out like the Desktop "Needs you" card: title and age, kind and pull request, the
 * Commander's Markdown, numbered options, and the owner's replies with their read state. Reply opens a composer in
 * place; Merge and Dismiss stay on Desktop.
 */
export const CommanderInboxCard = ({
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
    item: MobileCommanderInboxItem;
    /**
     * Lets the list bring the whole composer, Send included, above the keyboard once it opens.
     */
    onComposerFocus: () => void;
    onSend: (itemId: string, body: string) => Promise<boolean>;
    readAt: number;
    theme: MobileTheme;
}) => {
    const [isComposing, setComposing] = useState(false);
    const model = commanderInboxCardModel(item, readAt);
    const pullRequestUrl = item.pullRequest?.url;
    return (
        <View
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID={`commander-inbox-item-${item.id}`}
        >
            <View style={styles.titleRow}>
                <Text style={[styles.title, { color: theme.text }]}>{item.title}</Text>
                <Text style={[styles.meta, { color: theme.muted }]}>{model.ageLabel}</Text>
            </View>
            <View style={styles.metaRow}>
                <Text style={[styles.meta, { color: theme.muted }]}>{model.kindLabel}</Text>
                {pullRequestUrl && model.pullRequestLabel ? (
                    <Pressable
                        accessibilityHint="Opens the pull request in the browser."
                        accessibilityRole="link"
                        hitSlop={8}
                        onPress={() => {
                            // eslint-disable-next-line no-void -- openExternalLink reports a refused link itself.
                            void openExternalLink(pullRequestUrl);
                        }}
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
                <Text style={[styles.meta, { color: theme.muted }]}>
                    Shortened on the phone. The full text is on your computer.
                </Text>
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
                <CommanderInboxReplies item={item} replyState={model.replyState} theme={theme} />
            ) : null}
            {isComposing ? (
                <CommanderInboxReplyComposer
                    error={error}
                    isSending={isSending}
                    item={item}
                    onClose={() => setComposing(false)}
                    onComposerFocus={onComposerFocus}
                    onSend={onSend}
                    theme={theme}
                />
            ) : (
                <Pressable
                    accessibilityRole="button"
                    onPress={() => setComposing(true)}
                    style={[styles.replyButton, { borderColor: theme.border }]}
                    testID={`commander-inbox-reply-${item.id}`}
                >
                    <MessageSquareReply color={theme.primary} size={16} />
                    <Text style={[styles.actionText, { color: theme.primary }]}>Reply</Text>
                </Pressable>
            )}
        </View>
    );
};

/**
 * The owner's replies on one card, with the Commander's read state under the latest.
 */
const CommanderInboxReplies = ({
    item,
    replyState,
    theme,
}: {
    item: MobileCommanderInboxItem;
    replyState: ReturnType<typeof commanderInboxCardModel>['replyState'];
    theme: MobileTheme;
}) => (
    <View style={[styles.replies, { borderColor: theme.border }]}>
        {item.earlierReplyCount > 0 ? (
            <Text style={[styles.meta, { color: theme.muted }]}>
                {`${item.earlierReplyCount} earlier ${item.earlierReplyCount === 1 ? 'reply' : 'replies'}`}
            </Text>
        ) : null}
        {item.replies.map((reply) => (
            <Text key={reply.sequence} style={[styles.reply, { color: theme.text }]}>
                {reply.body}
            </Text>
        ))}
        {replyState ? (
            <Text
                style={[styles.meta, { color: replyState.isRead ? theme.success : theme.muted }]}
                testID={`commander-inbox-reply-state-${item.id}`}
            >
                {replyState.label}
            </Text>
        ) : null}
    </View>
);

/**
 * The in-place reply composer of one card. It owns the draft, so Cancel discards it.
 */
const CommanderInboxReplyComposer = ({
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
    item: MobileCommanderInboxItem;
    onClose: () => void;
    onComposerFocus: () => void;
    onSend: (itemId: string, body: string) => Promise<boolean>;
    theme: MobileTheme;
}) => {
    const [draft, setDraft] = useState('');
    const body = commanderInboxReplyBody(draft);
    const send = async (): Promise<void> => {
        if (body && (await onSend(item.id, body))) onClose();
    };
    return (
        <View style={styles.composer}>
            <TextInput
                accessibilityLabel={`Reply to ${item.title}`}
                autoFocus
                editable={!isSending}
                multiline
                onChangeText={setDraft}
                onFocus={onComposerFocus}
                placeholder="Reply to the Commander"
                placeholderTextColor={theme.muted}
                style={[
                    styles.input,
                    {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                        color: theme.text,
                    },
                ]}
                testID={`commander-inbox-reply-input-${item.id}`}
                value={draft}
            />
            {error ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.meta, { color: theme.danger }]}
                    testID={`commander-inbox-reply-error-${item.id}`}
                >
                    {error}
                </Text>
            ) : null}
            <View style={styles.actions}>
                <Pressable
                    accessibilityRole="button"
                    disabled={isSending}
                    onPress={onClose}
                    style={styles.action}
                    testID={`commander-inbox-reply-cancel-${item.id}`}
                >
                    <Text style={[styles.actionText, { color: theme.muted }]}>Cancel</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ busy: isSending, disabled: !body || isSending }}
                    disabled={!body || isSending}
                    onPress={() => {
                        // eslint-disable-next-line no-void -- The reply hook renders send failures.
                        void send();
                    }}
                    style={[
                        styles.action,
                        {
                            backgroundColor: theme.primary,
                            opacity: !body || isSending ? 0.5 : 1,
                        },
                    ]}
                    testID={`commander-inbox-reply-send-${item.id}`}
                >
                    {isSending ? (
                        <ActivityIndicator color={theme.primaryForeground} size="small" />
                    ) : (
                        <Text style={[styles.actionText, { color: theme.primaryForeground }]}>
                            Send
                        </Text>
                    )}
                </Pressable>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 14 },
    titleRow: { alignItems: 'baseline', flexDirection: 'row', gap: 8 },
    title: { flex: 1, fontSize: 16, fontWeight: '600', lineHeight: 22 },
    metaRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    meta: { fontSize: 13 },
    link: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    options: { gap: 4 },
    option: { fontSize: 15, lineHeight: 21 },
    replies: { borderLeftWidth: 2, gap: 6, paddingLeft: 10 },
    reply: { fontSize: 15, lineHeight: 21 },
    composer: { gap: 8 },
    input: {
        borderRadius: 10,
        borderWidth: 1,
        fontSize: 15,
        maxHeight: 160,
        minHeight: 72,
        paddingHorizontal: 12,
        paddingVertical: 10,
        textAlignVertical: 'top',
    },
    actions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
    action: {
        alignItems: 'center',
        borderRadius: 18,
        justifyContent: 'center',
        minHeight: 36,
        minWidth: 72,
        paddingHorizontal: 14,
    },
    actionText: { fontSize: 14, fontWeight: '700' },
    replyButton: {
        alignItems: 'center',
        alignSelf: 'flex-start',
        borderRadius: 18,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 6,
        minHeight: 36,
        paddingHorizontal: 14,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
