import type { RefObject } from 'react';
import type { TextInputInstance } from 'react-native';
import { TextInput } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';

/**
 * The Chat's message field: Return inserts a new line, and the placeholder says whether a message starts a turn or
 * joins the running one.
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
    inputReference: RefObject<TextInputInstance | null>;
    isEditable: boolean;
    isRunning: boolean;
    onComposerFocused: (() => void) | undefined;
    onDraftChange: (draft: string) => void;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <TextInput
            accessibilityHint={t(
                isRunning ? 'chat.composer.inputHintSteer' : 'chat.composer.inputHintSend',
            )}
            accessibilityLabel={t('chat.composer.messageProvider', { provider })}
            editable={isEditable}
            multiline
            numberOfLines={6}
            onChangeText={onDraftChange}
            onFocus={() => {
                if (focusComposer) onComposerFocused?.();
            }}
            ref={inputReference}
            // Desktop's wording without its ⌘Enter hint, kept to one line so the input does not grow mid-turn.
            placeholder={
                isRunning
                    ? t('chat.composer.steerPlaceholder')
                    : t('chat.composer.messageProvider', { provider })
            }
            placeholderTextColor={theme.muted}
            scrollEnabled
            submitBehavior="newline"
            style={[
                styles.composer,
                // Android adds the font's ascent padding above the first line; with a fixed lineHeight inside a
                // max-height scroller that extra space pushes the first line's top under the clip edge (#1937).
                { includeFontPadding: false },
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
};
