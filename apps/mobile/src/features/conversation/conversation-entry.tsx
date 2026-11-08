import type { ComponentProps, ReactNode } from 'react';
import { memo, use, useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationHandoffCard } from './conversation-handoff-card';
import { ConversationMarkdown } from './conversation-markdown';
import type { ConversationMessageTarget } from './conversation-message-actions';
import {
    ConversationMessageActions,
    ConversationMessageLongPress,
} from './conversation-message-actions';
import type { ConversationEntry as Entry } from './conversation-model';
import { conversationTurnDivider } from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationSystemEvent } from './conversation-system-event';
import { ConversationToolDetail } from './conversation-tool-detail';
import { ConversationToolGroup } from './conversation-tool-group';
import { ConversationToolRow } from './conversation-tool-row';
import { ConversationUserAttachments } from './conversation-user-attachments';
import type { ConversationUserText } from './conversation-user-text';
import { conversationActionText, conversationUserText } from './conversation-user-text';
import { ConversationUserWords } from './conversation-user-words';
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
    const paced = useConversationPacedText(text, isStreaming);
    /**
     * Once a reply paced in this mount it keeps fading after the pacing ends: the last characters reach the screen
     * nearly transparent, and dropping the reveal then drew them all opaque at once, the block the pacing exists to
     * avoid.
     */
    const [hasPaced, setHasPaced] = useState(paced.isPacing);
    if (!hasPaced && paced.isPacing) setHasPaced(true);
    return (
        <ConversationMarkdown
            reveal={hasPaced ? { since: mountedAt, textShownAt: paced.shownAt } : undefined}
            text={paced.text}
            theme={theme}
        />
    );
};

/**
 * A message that opens its actions on a long press, as chat apps do. Without actions it is a plain view. The text
 * inside is not `selectable`: on Android a selectable text claims the long press for its own selection, so the press
 * would never reach the actions; Select Text in the sheet offers selection instead. A control inside that takes its own
 * presses forwards the long press through `ConversationMessageLongPress`.
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
    const { id, role, text } = message;
    // Stable while the message is, so a code block reading it does not redraw with every parent render.
    const openMessage = useCallback(
        () => openActions?.({ id, role, text }),
        [id, openActions, role, text],
    );
    if (!openActions)
        return (
            <View style={style} testID={testID}>
                {children}
            </View>
        );
    return (
        <Pressable
            accessibilityActions={[{ name: 'longpress', label: t('conversation.message.actions') }]}
            onAccessibilityAction={openMessage}
            onLongPress={openMessage}
            style={style}
            testID={testID}
        >
            <ConversationMessageLongPress value={openMessage}>
                {children}
            </ConversationMessageLongPress>
        </Pressable>
    );
};

/**
 * The user's message: what it cites above (`userExtras`), then one bubble holding its words and, under them, the images
 * and videos it carried, as Desktop lays a message out. With neither words nor attachments it has no bubble.
 */
const ConversationUserMessage = ({
    entry,
    handoff,
    theme,
    userExtras,
    userLeading,
}: {
    entry: Extract<Entry, { type: 'userMessage' }>;
    handoff?: { footer?: ReactNode; note: string };
    theme: MobileTheme;
    userExtras?: ReactNode;
    userLeading?: ReactNode;
}) => {
    const renderUserAttachments = use(ConversationUserAttachments);
    const attachments = renderUserAttachments?.(entry.id) ?? null;
    const hasText = entry.text.length > 0;
    const user: ConversationUserText = handoff
        ? { kind: 'handoff', note: handoff.note }
        : conversationUserText(entry.text);
    const words =
        user.kind === 'handoff' ? (
            <ConversationHandoffCard footer={handoff?.footer} note={user.note} theme={theme} />
        ) : (
            <ConversationUserWords
                blocks={user.blocks}
                testID={`conversation-user-text-${entry.id}`}
                theme={theme}
            />
        );
    const bubble =
        attachments || hasText ? (
            <ConversationMessagePress
                message={{
                    id: entry.id,
                    role: 'user',
                    text: conversationActionText(entry.text),
                }}
                style={[styles.userBubble, { backgroundColor: theme.surface }]}
                testID={`conversation-user-bubble-${entry.id}`}
            >
                {hasText ? words : null}
                {attachments ? (
                    <View style={hasText ? styles.userAttachments : undefined}>{attachments}</View>
                ) : null}
            </ConversationMessagePress>
        ) : null;
    return (
        <View style={[styles.message, styles.userRow]} testID={`conversation-user-${entry.id}`}>
            {userExtras}
            {bubble && userLeading ? (
                <View style={styles.userLeadingRow}>
                    {userLeading}
                    {bubble}
                </View>
            ) : (
                bubble
            )}
        </View>
    );
};

export const ConversationEntry = memo(
    ({
        entry,
        theme,
        handoff,
        userExtras,
        userLeading,
    }: {
        entry: Entry;
        theme: MobileTheme;
        /**
         * Set when the message is a `/new-session` hand-off whose text the caller already reduced to the user's words
         * (an Agent Chat message): the card shows `note`, with `footer` under it such as the link to the Session it
         * started. A Terminal Agent's message is recognized from its text instead.
         */
        handoff?: { footer?: ReactNode; note: string };
        /**
         * Drawn above a user message's bubble, such as the files an Agent Chat message cites.
         */
        userExtras?: ReactNode;
        /**
         * Drawn beside a user message's bubble, before it, such as the mark of an Agent Chat message steered into a
         * running turn.
         */
        userLeading?: ReactNode;
    }) => {
        const { t } = useTranslation();
        const [selectedTool, setSelectedTool] = useState<ToolCall | null>(null);
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
                <ConversationUserMessage
                    entry={entry}
                    handoff={handoff}
                    theme={theme}
                    userExtras={userExtras}
                    userLeading={userLeading}
                />
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
                    {/* FlashList recycles a row's cell for another entry, keeping its state; the key gives each reply its
                        own pacer, so a new reply does not start from the previous reply's text and show its first
                        burst whole. */}
                    <ConversationAgentMessage
                        isStreaming={entry.streaming === true}
                        key={entry.id}
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
