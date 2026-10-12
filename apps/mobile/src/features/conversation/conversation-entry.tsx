import { use, useState } from 'react';
import { Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';
import { agentChatTurnLabel } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from './conversation-markdown';
import type { ConversationEntry as Entry } from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationSystemEvent } from './conversation-system-event';
import { ConversationToolDetail } from './conversation-tool-detail';
import { ConversationToolGroup } from './conversation-tool-group';
import { ConversationToolRow } from './conversation-tool-row';
import { ConversationUserAttachments } from './conversation-user-attachments';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

/**
 * The caption that ends a turn (`Worked for 2m 1s`), a small centered pill like a chat app's time stamp. A failed or
 * stopped turn carries its tone in the text color, as Desktop's fold row does.
 */
export const ConversationTurnDivider = ({
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

export const ConversationEntry = ({ entry, theme }: { entry: Entry; theme: MobileTheme }) => {
    const [selectedTool, setSelectedTool] = useState<ToolCall | null>(null);
    const renderUserAttachments = use(ConversationUserAttachments);
    if (entry.type === 'turnBoundary')
        return (
            // A terminal Agent's record says only how long the turn took, so it reads as completed work.
            <ConversationTurnDivider
                label={agentChatTurnLabel({ durationMs: entry.durationMs, status: 'completed' })}
                testID={`conversation-turn-${entry.id}`}
                theme={theme}
            />
        );
    if (entry.type === 'userMessage')
        return (
            <View style={[styles.message, styles.userRow]} testID={`conversation-user-${entry.id}`}>
                {renderUserAttachments?.(entry.id)}
                {entry.text.length > 0 ? (
                    <View style={[styles.userBubble, { backgroundColor: theme.surface }]}>
                        <Text selectable style={[styles.userText, { color: theme.text }]}>
                            {entry.text}
                        </Text>
                    </View>
                ) : null}
            </View>
        );
    if (entry.type === 'systemEvent')
        return <ConversationSystemEvent event={entry} theme={theme} />;
    if (entry.type === 'agentMessage')
        return (
            <View style={styles.message} testID={`conversation-agent-${entry.id}`}>
                <ConversationMarkdown text={entry.text} theme={theme} />
            </View>
        );
    return (
        <View style={styles.message}>
            {entry.type === 'toolCall' ? (
                <View style={[styles.toolGroup, { borderColor: theme.border }]}>
                    <ConversationToolRow onPress={setSelectedTool} theme={theme} tool={entry} />
                </View>
            ) : (
                <ConversationToolGroup group={entry} onToolPress={setSelectedTool} theme={theme} />
            )}
            <ConversationToolDetail
                onClose={() => setSelectedTool(null)}
                theme={theme}
                tool={selectedTool}
            />
        </View>
    );
};
