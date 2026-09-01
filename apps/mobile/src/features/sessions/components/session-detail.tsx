import { useRef } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';

import { MOBILE_SHORT_REPLY_MAX_BYTES } from '@caxri/protocol';

import type { MobileTheme } from '../../../theme/tokens';
import { useShortReply } from '../hooks/use-short-reply';
import type { TerminalPreviewViewState } from '../hooks/use-terminal-preview';
import type { MobileSessionItem } from '../session-model';
import { terminalPreviewFallback } from '../session-model';

const styles = StyleSheet.create({
    backButton: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center' },
    backLabel: { fontSize: 15, fontWeight: '600' },
    byteCount: { flexShrink: 0, fontSize: 12 },
    composer: {
        borderRadius: 12,
        borderWidth: 1,
        fontSize: 15,
        minHeight: 50,
        paddingHorizontal: 14,
        paddingVertical: 12,
    },
    composerBlock: { gap: 10 },
    composerMeta: {
        alignItems: 'flex-start',
        flexDirection: 'row',
        gap: 12,
        justifyContent: 'space-between',
    },
    detail: { flex: 1 },
    detailHeader: { borderBottomWidth: 1, paddingHorizontal: 20, paddingVertical: 16 },
    detailMeta: { fontSize: 13, marginTop: 5 },
    detailScroll: {
        gap: 24,
        marginHorizontal: 'auto',
        maxWidth: 680,
        padding: 20,
        width: '100%',
    },
    detailTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.4, lineHeight: 28 },
    preview: { borderRadius: 14, borderWidth: 1, maxHeight: 320, minHeight: 180 },
    previewContent: { flexGrow: 1, padding: 16 },
    previewError: {
        alignItems: 'center',
        borderRadius: 12,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 12,
        justifyContent: 'space-between',
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    previewErrorText: { flex: 1, fontSize: 13, lineHeight: 18 },
    previewHeading: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: -16,
    },
    previewText: {
        fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo' }),
        fontSize: 15,
        lineHeight: 22,
    },
    previewRetry: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 8 },
    previewRetryLabel: { fontSize: 14, fontWeight: '700' },
    reason: { flex: 1, fontSize: 12, lineHeight: 18 },
    sectionTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
    sendButton: {
        alignItems: 'center',
        borderRadius: 12,
        justifyContent: 'center',
        minHeight: 52,
        paddingHorizontal: 18,
    },
    sendError: { fontSize: 13, lineHeight: 19 },
    sendSuccess: { fontSize: 13, fontWeight: '600', lineHeight: 19 },
    sendLabel: { fontSize: 15, fontWeight: '700' },
    truncated: { fontSize: 12 },
});

export const SessionDetail = ({
    isConnected,
    onBack,
    onRefresh,
    previewState,
    session,
    theme,
}: {
    isConnected: boolean;
    onBack?: () => void;
    onRefresh: () => Promise<void>;
    previewState: TerminalPreviewViewState;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const previewScroll = useRef<ScrollView>(null);
    const { error: previewError, isLoading: previewLoading, preview, refresh } = previewState;
    const {
        byteLength,
        canSend,
        disabledReason,
        draft,
        replySent,
        send,
        sendError,
        sending,
        updateDraft,
    } = useShortReply({ isConnected, onRefresh, session });

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={[styles.detail, { backgroundColor: theme.background }]}
            testID="session-detail"
        >
            <View style={[styles.detailHeader, { borderColor: theme.border }]}>
                {onBack ? (
                    <Pressable
                        accessibilityHint="Returns to the Session list."
                        accessibilityRole="button"
                        onPress={onBack}
                        style={styles.backButton}
                        testID="session-detail-back"
                    >
                        <Text style={[styles.backLabel, { color: theme.text }]}>← Sessions</Text>
                    </Pressable>
                ) : null}
                <Text
                    accessibilityRole="header"
                    numberOfLines={2}
                    style={[styles.detailTitle, { color: theme.text }]}
                >
                    {session.displayTitle}
                </Text>
                <Text style={[styles.detailMeta, { color: theme.muted }]}>
                    {session.projectTitle} · {session.stateLabel}
                </Text>
            </View>
            <ScrollView
                contentContainerStyle={styles.detailScroll}
                keyboardShouldPersistTaps="handled"
            >
                <View style={styles.previewHeading}>
                    <Text style={[styles.sectionTitle, { color: theme.muted }]}>LATEST OUTPUT</Text>
                    {preview?.truncated ? (
                        <Text style={[styles.truncated, { color: theme.muted }]}>
                            Newest 16 KiB
                        </Text>
                    ) : null}
                </View>
                {previewError ? (
                    <View
                        style={[
                            styles.previewError,
                            { backgroundColor: theme.surface, borderColor: theme.border },
                        ]}
                    >
                        <Text
                            accessibilityRole="alert"
                            style={[styles.previewErrorText, { color: theme.text }]}
                        >
                            {previewError}
                            {preview ? ' Showing the last known output.' : ''}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ disabled: previewLoading }}
                            disabled={previewLoading}
                            onPress={refresh}
                            style={[styles.previewRetry, { opacity: previewLoading ? 0.5 : 1 }]}
                            testID="terminal-preview-retry"
                        >
                            <Text style={[styles.previewRetryLabel, { color: theme.primary }]}>
                                Retry
                            </Text>
                        </Pressable>
                    </View>
                ) : null}
                <ScrollView
                    ref={previewScroll}
                    contentContainerStyle={styles.previewContent}
                    nestedScrollEnabled
                    onContentSizeChange={() =>
                        previewScroll.current?.scrollToEnd({ animated: false })
                    }
                    style={[
                        styles.preview,
                        { backgroundColor: theme.surface, borderColor: theme.border },
                    ]}
                >
                    <Text
                        selectable
                        style={[styles.previewText, { color: theme.text }]}
                        testID={
                            preview?.content ? 'terminal-preview-populated' : 'terminal-preview'
                        }
                    >
                        {preview === null
                            ? session.primaryAgentTerminalId
                                ? previewLoading
                                    ? 'Loading the latest Agent output…'
                                    : previewError
                                      ? 'Latest Agent output could not be loaded.'
                                      : 'Output is unavailable.'
                                : 'This Session has no primary Agent output.'
                            : preview.content ||
                              (preview.availability === 'unavailable'
                                  ? 'Output is unavailable.'
                                  : terminalPreviewFallback(session, preview.availability))}
                    </Text>
                </ScrollView>
                <View style={styles.composerBlock}>
                    <Text style={[styles.sectionTitle, { color: theme.muted }]}>SHORT REPLY</Text>
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
                        <Text
                            style={[
                                styles.reason,
                                { color: disabledReason ? theme.muted : theme.text },
                            ]}
                        >
                            {disabledReason ??
                                'Sends to the waiting primary Agent and presses Enter.'}
                        </Text>
                        <Text style={[styles.byteCount, { color: theme.muted }]}>
                            {byteLength}/{MOBILE_SHORT_REPLY_MAX_BYTES} B
                        </Text>
                    </View>
                    <View accessibilityLiveRegion="polite">
                        {sendError ? (
                            <Text
                                accessibilityRole="alert"
                                style={[styles.sendError, { color: theme.danger }]}
                            >
                                {sendError}
                            </Text>
                        ) : null}
                        {replySent ? (
                            <Text
                                style={[styles.sendSuccess, { color: theme.primary }]}
                                testID="short-reply-success"
                            >
                                Reply sent.
                            </Text>
                        ) : null}
                    </View>
                    <Pressable
                        accessibilityLabel={sending ? 'Sending reply' : 'Send reply'}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canSend }}
                        disabled={!canSend}
                        onPress={send}
                        style={({ pressed }) => [
                            styles.sendButton,
                            {
                                backgroundColor: theme.primary,
                                opacity: !canSend ? 0.38 : pressed ? 0.72 : 1,
                            },
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
            </ScrollView>
        </KeyboardAvoidingView>
    );
};
