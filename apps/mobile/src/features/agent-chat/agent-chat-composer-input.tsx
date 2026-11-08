import type { RefObject } from 'react';
import { useMemo, useState } from 'react';
import type { TextInputInstance } from 'react-native';
import { TextInput } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import { AgentChatComposerDraft } from './agent-chat-composer-draft';
import { agentChatComposerSpans } from './agent-chat-composer-spans';

/**
 * The Chat's message field: Return inserts a new line, and the placeholder says whether a message starts a turn or
 * joins the running one. The draft renders its Markdown as it is typed, as Desktop's composer does: the field holds the
 * exact text and draws it as styled runs (`agentChatComposerSpans`), so the message sent is what was typed.
 */
export const AgentChatComposerInput = ({
    draft,
    focusComposer,
    imagePlaceholders,
    inputReference,
    isEditable,
    isExpanded,
    isRunning,
    onComposerFocused,
    onDraftChange,
    onFocusChange,
    provider,
    theme,
}: {
    draft: string;
    focusComposer: boolean | undefined;
    /**
     * The draft's `[Image #N]` pills: which numbers attached images own, where the caret is, and whole-pill deletion.
     */
    imagePlaceholders: {
        edited: (next: string) => string;
        onCursorChange: (offset: number) => void;
        owned: ReadonlySet<number>;
    };
    inputReference: RefObject<TextInputInstance | null>;
    isEditable: boolean;
    /**
     * Whether the capsule is expanded, with the input across its top row instead of between its buttons.
     */
    isExpanded: boolean;
    isRunning: boolean;
    onComposerFocused: (() => void) | undefined;
    onDraftChange: (draft: string) => void;
    /**
     * Reports focus so the capsule expands while the reader types (`agentChatComposerLayout`).
     */
    onFocusChange: (isFocused: boolean) => void;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [selection, setSelection] = useState({ end: draft.length, start: draft.length });
    const spans = useMemo(
        () => agentChatComposerSpans(draft, selection, imagePlaceholders.owned),
        [draft, imagePlaceholders.owned, selection],
    );
    return (
        <TextInput
            accessibilityHint={t(
                isRunning ? 'chat.composer.inputHintSteer' : 'chat.composer.inputHintSend',
            )}
            accessibilityLabel={t('chat.composer.messageProvider', { provider })}
            editable={isEditable}
            multiline
            numberOfLines={6}
            onBlur={() => onFocusChange(false)}
            onChangeText={(next) => onDraftChange(imagePlaceholders.edited(next))}
            onSelectionChange={(event) => {
                setSelection(event.nativeEvent.selection);
                imagePlaceholders.onCursorChange(event.nativeEvent.selection.end);
            }}
            onFocus={() => {
                onFocusChange(true);
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
                isExpanded ? styles.composerExpanded : styles.composer,
                // Android adds the font's ascent padding above the first line; with a fixed lineHeight inside a
                // max-height scroller that extra space pushes the first line's top under the clip edge (#1937).
                { color: theme.text, includeFontPadding: false },
            ]}
            testID="agent-chat-composer-input"
            textAlignVertical="top"
        >
            <AgentChatComposerDraft spans={spans} theme={theme} />
        </TextInput>
    );
};
