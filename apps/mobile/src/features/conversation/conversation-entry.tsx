import type { ComponentProps, ReactNode } from 'react';
import { memo, use, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import type { AgentTimelineItem } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from './conversation-markdown';
import type { ConversationMessageTarget } from './conversation-message-actions';
import { ConversationMessageActions } from './conversation-message-actions';
import type { ConversationEntry as Entry } from './conversation-model';
import { conversationTurnDivider } from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationSystemEvent } from './conversation-system-event';
import { ConversationToolDetail } from './conversation-tool-detail';
import { ConversationToolGroup } from './conversation-tool-group';
import { ConversationToolRow } from './conversation-tool-row';
import { ConversationUserAttachments } from './conversation-user-attachments';
import { useConversationPacedText } from './use-conversation-paced-text';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

/**
 * The caption that ends a turn (`Worked for 2m 1s`), a small centered pill like a chat app's time stamp. A failed or
 * stopped turn carries its tone in the text color, as Desktop's fold row does.
 */
const ConversationTurnDivider = ({
    label,
    testID,
    theme,
    tone = 'muted',
}: {
    label: string;
    testID: string;
    theme: MobileTheme;
    tone?: 'danger' | 'muted' | 'warning';
}) => (
    <View style={[styles.message, styles.turnDivider]} testID={testID}>
        <View style={[styles.turnPill, { backgroundColor: theme.surface }]}>
            <Text style={[styles.turnText, { color: theme[tone] }]}>{label}</Text>
        </View>
    </View>
);

/**
 * A reply, paced onto the screen while it streams with its new text fading in, as Desktop's reply does. Reduced motion
 * skips both.
 */
const ConversationAgentMessage = ({
    isStreaming,
    text,
    theme,
}: {
    isStreaming: boolean;
    text: string;
    theme: MobileTheme;
}) => {
    const [mountedAt] = useState(() => performance.now());
    const isReducedMotion = useReducedMotion();
    const paced = useConversationPacedText(text, isStreaming);
    return (
        <ConversationMarkdown
            reveal={
                isStreaming && !isReducedMotion
                    ? { since: mountedAt, textShownAt: paced.shownAt }
                    : undefined
            }
            text={paced.text}
            theme={theme}
        />
    );
};

/**
 * A message that opens its actions on a long press, as chat apps do. Without actions it is a plain view. The text
 * inside is not `selectable`: on Android a selectable text claims the long press for its own selection, so the press
 * would never reach the actions; Select Text in the sheet offers selection instead.
 */
const ConversationMessagePress = ({
    children,
    message,
    style,
    testID,
}: {
    children: ReactNode;
    message: ConversationMessageTarget;
    style: ComponentProps<typeof View>['style'];
    testID: string;
}) => {
    const { t } = useTranslation();
    const openActions = use(ConversationMessageActions);
    if (!openActions)
        return (
            <View style={style} testID={testID}>
                {children}
            </View>
        );
    return (
        <Pressable
            accessibilityActions={[{ name: 'longpress', label: t('conversation.message.actions') }]}
            onAccessibilityAction={() => openActions(message)}
            onLongPress={() => openActions(message)}
            style={style}
            testID={testID}
        >
            {children}
        </Pressable>
    );
};

export const ConversationEntry = memo(
    ({
        entry,
        theme,
        userExtras,
    }: {
        entry: Entry;
        theme: MobileTheme;
        /**
         * Drawn between a user message's attachments and its bubble, such as the files an Agent Chat message cites.
         */
        userExtras?: ReactNode;
    }) => {
        const { t } = useTranslation();
        const [selectedTool, setSelectedTool] = useState<ToolCall | null>(null);
        const renderUserAttachments = use(ConversationUserAttachments);
        if (entry.type === 'turnBoundary') {
            const divider = conversationTurnDivider(entry, t);
            return (
                <ConversationTurnDivider
                    label={divider.label}
                    testID={`conversation-turn-${entry.id}`}
                    theme={theme}
                    tone={divider.tone}
                />
            );
        }
        if (entry.type === 'userMessage')
            return (
                <View
                    style={[styles.message, styles.userRow]}
                    testID={`conversation-user-${entry.id}`}
                >
                    {renderUserAttachments?.(entry.id)}
                    {userExtras}
                    {entry.text.length > 0 ? (
                        <ConversationMessagePress
                            message={{ id: entry.id, role: 'user', text: entry.text }}
                            style={[styles.userBubble, { backgroundColor: theme.surface }]}
                            testID={`conversation-user-bubble-${entry.id}`}
                        >
                            <Text style={[styles.userText, { color: theme.text }]}>
                                {entry.text}
                            </Text>
                        </ConversationMessagePress>
                    ) : null}
                </View>
            );
        if (entry.type === 'systemEvent')
            return <ConversationSystemEvent event={entry} theme={theme} />;
        if (entry.type === 'agentMessage')
            return (
                <ConversationMessagePress
                    message={{ id: entry.id, role: 'agent', text: entry.text }}
                    style={styles.message}
                    testID={`conversation-agent-${entry.id}`}
                >
                    <ConversationAgentMessage
                        isStreaming={entry.streaming === true}
                        text={entry.text}
                        theme={theme}
                    />
                </ConversationMessagePress>
            );
        return (
            <View style={styles.message}>
                {entry.type === 'toolCall' ? (
                    <View style={[styles.toolGroup, { borderColor: theme.border }]}>
                        <ConversationToolRow onPress={setSelectedTool} theme={theme} tool={entry} />
                    </View>
                ) : (
                    <ConversationToolGroup
                        group={entry}
                        onToolPress={setSelectedTool}
                        theme={theme}
                    />
                )}
                <ConversationToolDetail
                    onClose={() => setSelectedTool(null)}
                    theme={theme}
                    tool={selectedTool}
                />
            </View>
        );
    },
);
