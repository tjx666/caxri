import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';
import { Check, CircleAlert } from 'lucide-react-native';

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
        <View style={styles.toolIcon}>
            {tool.status === 'running' ? (
                <ActivityIndicator color={theme.muted} size={14} />
            ) : tool.status === 'failed' ? (
                <CircleAlert color={theme.danger} size={15} />
            ) : (
                <Check color={theme.muted} size={15} />
            )}
        </View>
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
