import type { RefObject } from 'react';
import { TextInput } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';

/**
 * The Chat's message field: Return inserts a new line, and the placeholder says whether a message starts a turn or
 * queues behind the running one.
 */
export const AgentChatComposerInput = ({
    draft,
    focusComposer,
    inputReference,
    isEditable,
    isRunning,
    onComposerFocused,
    onDraftChange,
    provider,
    theme,
}: {
    draft: string;
    focusComposer: boolean | undefined;
    inputReference: RefObject<TextInput | null>;
    isEditable: boolean;
    isRunning: boolean;
    onComposerFocused: (() => void) | undefined;
    onDraftChange: (draft: string) => void;
    provider: string;
    theme: MobileTheme;
}) => (
    <TextInput
        accessibilityHint={`Return inserts a new line. Use ${isRunning ? 'Queue' : 'Send'} message to submit.`}
        accessibilityLabel={`Message ${provider}`}
        editable={isEditable}
        multiline
        numberOfLines={6}
        onChangeText={onDraftChange}
        onFocus={() => {
            if (focusComposer) onComposerFocused?.();
        }}
        ref={inputReference}
        // Desktop's wording without its ⌘Enter hint, kept to one line so the input does not grow mid-turn.
        placeholder={isRunning ? 'Queue a follow-up' : `Message ${provider}`}
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
);
