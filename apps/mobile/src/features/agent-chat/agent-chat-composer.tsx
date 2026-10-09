import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { ArrowUp, Square } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import { agentChatComposerDisabledReason } from './agent-chat-model';
import type { AgentChatController } from './use-agent-chat';

/**
 * Sends a message to a Chat. While a turn runs, a control device gets Stop in place of Send when the draft is empty,
 * matching the Desktop composer; a message typed during a turn steers it.
 */
export const AgentChatComposer = ({
    chat,
    deviceRole,
    draft,
    isConnected,
    onDraftChange,
    provider,
    theme,
}: {
    chat: AgentChatController;
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    isConnected: boolean;
    onDraftChange: (draft: string) => void;
    provider: string;
    theme: MobileTheme;
}) => {
    const [isBusy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const disabledReason = agentChatComposerDisabledReason({
        deviceRole,
        isConnected,
        snapshot: chat.snapshot,
    });
    const isRunning = Boolean(chat.snapshot?.activeTurnId);
    const isStopAction = isRunning && deviceRole === 'control' && draft.trim().length === 0;
    const canSubmit =
        !isBusy && disabledReason === undefined && (isStopAction || draft.trim().length > 0);
    const submit = async (): Promise<void> => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            if (isStopAction) await chat.interrupt();
            else {
                await chat.send(draft.trim());
                onDraftChange('');
            }
        } catch {
            setError(
                isStopAction
                    ? `${provider} could not be stopped. Try again.`
                    : 'Your message was not sent. Try again.',
            );
        } finally {
            setBusy(false);
        }
    };
    const Icon = isStopAction ? Square : ArrowUp;
    return (
        <View
            style={[styles.composerBlock, { borderColor: theme.border }]}
            testID="agent-chat-composer"
        >
            <View style={styles.composerRow}>
                <TextInput
                    accessibilityHint="Return inserts a new line. Use Send message to submit."
                    accessibilityLabel={`Message ${provider}`}
                    editable={!isBusy && disabledReason === undefined}
                    multiline
                    numberOfLines={6}
                    onChangeText={onDraftChange}
                    placeholder={
                        isRunning ? `Reply while ${provider} works` : `Message ${provider}`
                    }
                    placeholderTextColor={theme.muted}
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
                    testID="agent-chat-composer-input"
                    textAlignVertical="top"
                    value={draft}
                />
                <Pressable
                    accessibilityLabel={isStopAction ? `Stop ${provider}` : 'Send message'}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canSubmit, busy: isBusy }}
                    disabled={!canSubmit}
                    onPress={submit}
                    style={[
                        styles.sendButton,
                        {
                            backgroundColor: isStopAction ? theme.danger : theme.primary,
                            opacity: canSubmit ? 1 : 0.38,
                        },
                    ]}
                    testID={isStopAction ? 'agent-chat-composer-stop' : 'agent-chat-composer-send'}
                >
                    {isBusy ? (
                        <ActivityIndicator color={theme.primaryForeground} />
                    ) : (
                        <Icon color={theme.primaryForeground} size={20} strokeWidth={2.5} />
                    )}
                </Pressable>
            </View>
            {disabledReason ? (
                <Text style={[styles.reason, { color: theme.muted }]}>{disabledReason}</Text>
            ) : null}
            {error ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.sendState, { color: theme.danger }]}
                    testID="agent-chat-composer-error"
                >
                    {error}
                </Text>
            ) : null}
        </View>
    );
};
