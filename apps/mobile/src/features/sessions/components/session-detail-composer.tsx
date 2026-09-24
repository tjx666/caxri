import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { MOBILE_SHORT_REPLY_MAX_BYTES } from '@caxri/protocol';

import type { MobileTheme } from '../../../theme/tokens';
import { useShortReply } from '../hooks/use-short-reply';
import type { MobileSessionItem } from '../session-model';
import { sessionDetailStyles as styles } from './session-detail-styles';

export const SessionDetailComposer = ({
    draft,
    isConnected,
    onDraftChange,
    onRefresh,
    session,
    theme,
}: {
    draft: string;
    isConnected: boolean;
    onDraftChange: (draft: string) => void;
    onRefresh: () => Promise<void>;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const {
        byteLength,
        canSend,
        disabledReason,
        replySent,
        send,
        sendError,
        sending,
        updateDraft,
    } = useShortReply({ draft, isConnected, onDraftChange, onRefresh, session });
    return (
        <View style={[styles.composerBlock, { borderColor: theme.border }]}>
            <TextInput
                accessibilityHint="Sends plain text followed by Enter to the waiting primary Agent."
                editable={!sending}
                onChangeText={updateDraft}
                onSubmitEditing={send}
                placeholder="Reply to the waiting Agent"
                placeholderTextColor={theme.muted}
                returnKeyType="send"
                style={[
                    styles.composer,
                    {
                        backgroundColor: theme.surface,
                        borderColor: theme.border,
                        color: theme.text,
                    },
                ]}
                testID="short-reply-input"
                value={draft}
            />
            <View style={styles.composerMeta}>
                <Text style={[styles.reason, { color: disabledReason ? theme.muted : theme.text }]}>
                    {disabledReason ?? 'Sends to the waiting primary Agent and presses Enter.'}
                </Text>
                <Text style={[styles.byteCount, { color: theme.muted }]}>
                    {byteLength}/{MOBILE_SHORT_REPLY_MAX_BYTES} B
                </Text>
            </View>
            {sendError ? (
                <Text accessibilityRole="alert" style={[styles.sendState, { color: theme.danger }]}>
                    {sendError}
                </Text>
            ) : null}
            {replySent ? (
                <Text
                    style={[styles.sendState, { color: theme.primary }]}
                    testID="short-reply-success"
                >
                    Reply sent.
                </Text>
            ) : null}
            <Pressable
                accessibilityLabel={sending ? 'Sending reply' : 'Send reply'}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                onPress={send}
                style={[
                    styles.sendButton,
                    { backgroundColor: theme.primary, opacity: canSend ? 1 : 0.38 },
                ]}
                testID="short-reply-send"
            >
                {sending ? (
                    <ActivityIndicator color={theme.primaryForeground} />
                ) : (
                    <Text style={[styles.sendLabel, { color: theme.primaryForeground }]}>
                        Send reply
                    </Text>
                )}
            </Pressable>
        </View>
    );
};
