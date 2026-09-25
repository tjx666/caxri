import { Pressable, Text } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { formatConversationDuration } from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

export const ConversationToolRow = ({
    onPress,
    theme,
    tool,
}: {
    onPress: (tool: ToolCall) => void;
    theme: MobileTheme;
    tool: ToolCall;
}) => (
    <Pressable
        accessibilityLabel={`${tool.summary}. ${tool.status}. Open detail.`}
        accessibilityRole="button"
        onPress={() => onPress(tool)}
        style={styles.toolRow}
        testID={`conversation-tool-${tool.id}`}
    >
        <Text
            style={[
                styles.toolIcon,
                { color: tool.status === 'failed' ? theme.danger : theme.muted },
            ]}
        >
            {tool.status === 'running' ? '◌' : tool.status === 'failed' ? '!' : '✓'}
        </Text>
        <Text numberOfLines={1} style={[styles.toolSummary, { color: theme.text }]}>
            {tool.summary}
        </Text>
        {tool.durationMs !== undefined ? (
            <Text style={[styles.toolDuration, { color: theme.muted }]}>
                {formatConversationDuration(tool.durationMs)}
            </Text>
        ) : null}
    </Pressable>
);
