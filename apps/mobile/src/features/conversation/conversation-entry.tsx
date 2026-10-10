import { useState } from 'react';
import { Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';
import { formatShortDuration } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from './conversation-markdown';
import type { ConversationEntry as Entry } from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationSystemEvent } from './conversation-system-event';
import { ConversationToolDetail } from './conversation-tool-detail';
import { ConversationToolGroup } from './conversation-tool-group';
import { ConversationToolRow } from './conversation-tool-row';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

export const ConversationEntry = ({ entry, theme }: { entry: Entry; theme: MobileTheme }) => {
    const [selectedTool, setSelectedTool] = useState<ToolCall | null>(null);
    if (entry.type === 'turnBoundary')
        return (
            <View
                style={[styles.message, styles.turnDivider]}
                testID={`conversation-turn-${entry.id}`}
            >
                <View style={[styles.turnPill, { backgroundColor: theme.surface }]}>
                    <Text style={[styles.turnText, { color: theme.muted }]}>
                        {formatShortDuration(entry.durationMs) ?? 'Turn complete'}
                    </Text>
                </View>
            </View>
        );
    if (entry.type === 'userMessage')
        return (
            <View style={[styles.message, styles.userRow]} testID={`conversation-user-${entry.id}`}>
                <View style={[styles.userBubble, { backgroundColor: theme.surface }]}>
                    <Text selectable style={[styles.userText, { color: theme.text }]}>
                        {entry.text}
                    </Text>
                </View>
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
