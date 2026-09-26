import { useEffect, useRef } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { MOBILE_AGENT_SUBMIT_MAX_BYTES } from '@caxri/protocol';
import { ArrowUp, Square } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { useSessionComposer } from '../hooks/use-session-composer';
import type { ComposerDelivery } from '../session-composer-state';
import { composerDeliveryFeedback } from '../session-composer-state';
import type { MobileSessionItem } from '../session-model';
import { sessionAgentLabel } from '../session-row-model';
import { sessionDetailStyles as styles } from './session-detail-styles';

const SessionComposerInput = ({
    delivery,
    draft,
    focusComposer,
    isVisible,
    onComposerFocused,
    session,
    theme,
    updateDraft,
}: {
    delivery: ComposerDelivery;
    draft: string;
    focusComposer?: boolean;
    isVisible: boolean;
    onComposerFocused?: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
    updateDraft: (value: string) => void;
}) => {
    const inputReference = useRef<TextInput>(null);
    useEffect(() => {
        if (!focusComposer || !isVisible || !inputReference.current) return;
        inputReference.current.focus();
        if (inputReference.current.isFocused()) onComposerFocused?.();
    }, [focusComposer, isVisible, onComposerFocused]);

    const agentName = sessionAgentLabel(session);
    const recipient = ['No Agent', 'Shell'].includes(agentName) ? 'Agent' : agentName;
    const placeholder =
        session.lastActivityState === 'running'
            ? `Reply while ${recipient} works`
            : `Message ${recipient}`;

    return (
        <TextInput
            accessibilityLabel="Message Agent"
            accessibilityHint="Return inserts a new line. Use Send message to submit."
            editable={delivery.kind !== 'sending' && delivery.kind !== 'stopping'}
            multiline
            numberOfLines={6}
            onChangeText={updateDraft}
            onFocus={() => {
                if (focusComposer) onComposerFocused?.();
            }}
            placeholder={placeholder}
            placeholderTextColor={theme.muted}
            ref={inputReference}
            scrollEnabled
            submitBehavior="newline"
            style={[
                styles.composer,
                {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    color: theme.text,
                },
            ]}
            testID="session-composer-input"
            textAlignVertical="top"
            value={draft}
        />
    );
};

const SessionComposerActionButton = ({
    canSubmit,
    delivery,
    showStop,
    submit,
    theme,
}: {
    canSubmit: boolean;
    delivery: ComposerDelivery;
    showStop: boolean;
    submit: () => Promise<void>;
    theme: MobileTheme;
}) => {
    const isBusy = delivery.kind === 'sending' || delivery.kind === 'stopping';
    const Icon = showStop ? Square : ArrowUp;
    return (
        <Pressable
            accessibilityLabel={showStop ? 'Stop Agent' : 'Send message'}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit, busy: isBusy }}
            disabled={!canSubmit}
            onPress={submit}
            style={[
                styles.sendButton,
                {
                    backgroundColor: showStop ? theme.danger : theme.primary,
                    opacity: canSubmit ? 1 : 0.38,
                },
            ]}
            testID={showStop ? 'session-composer-stop' : 'session-composer-send'}
        >
            {isBusy ? (
                <ActivityIndicator color={theme.primaryForeground} />
            ) : (
                <Icon color={theme.primaryForeground} size={20} strokeWidth={2.5} />
            )}
        </Pressable>
    );
};

export const SessionDetailComposer = ({
    deviceRole,
    draft,
    focusComposer,
    hostId,
    isConnected,
    isVisible,
    onComposerFocused,
    onDraftChange,
    onRefresh,
    session,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    focusComposer?: boolean;
    hostId: string;
    isConnected: boolean;
    isVisible: boolean;
    onComposerFocused?: () => void;
    onDraftChange: (draft: string) => void;
    onRefresh: () => Promise<void>;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { byteLength, canSubmit, delivery, disabledReason, showStop, submit, updateDraft } =
        useSessionComposer({
            deviceRole,
            draft,
            hostId,
            isConnected,
            onDraftChange,
            onRefresh,
            session,
        });
    const feedback = composerDeliveryFeedback(delivery);
    /**
     * The limit only matters near it; showing `0/16384 B` on every idle composer was noise.
     */
    const isShowByteCount = byteLength > MOBILE_AGENT_SUBMIT_MAX_BYTES * 0.75;

    return (
        <View
            style={[styles.composerBlock, { borderColor: theme.border }]}
            testID="session-composer"
        >
            <View style={styles.composerRow}>
                <SessionComposerInput
                    delivery={delivery}
                    draft={draft}
                    focusComposer={focusComposer}
                    isVisible={isVisible}
                    onComposerFocused={onComposerFocused}
                    session={session}
                    theme={theme}
                    updateDraft={updateDraft}
                />
                <SessionComposerActionButton
                    canSubmit={canSubmit}
                    delivery={delivery}
                    showStop={showStop}
                    submit={submit}
                    theme={theme}
                />
            </View>
            {disabledReason || isShowByteCount ? (
                <View style={styles.composerMeta}>
                    <Text style={[styles.reason, { color: theme.muted }]}>
                        {disabledReason ?? ''}
                    </Text>
                    {isShowByteCount ? (
                        <Text style={[styles.byteCount, { color: theme.muted }]}>
                            {byteLength}/{MOBILE_AGENT_SUBMIT_MAX_BYTES} B
                        </Text>
                    ) : null}
                </View>
            ) : null}
            {feedback ? (
                <Text
                    accessibilityRole={feedback.isError ? 'alert' : 'text'}
                    style={[
                        styles.sendState,
                        { color: feedback.isError ? theme.danger : theme.muted },
                    ]}
                    testID="session-composer-feedback"
                >
                    {feedback.message}
                </Text>
            ) : null}
        </View>
    );
};
