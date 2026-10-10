import { Pressable, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';
import { describeAgentTool, formatShortDuration } from '@caxri/protocol';
import { CircleAlert } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationToolIcon } from './conversation-tool-icon';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

export const ConversationToolRow = ({
    onPress,
    theme,
    tool,
}: {
    onPress: (tool: ToolCall) => void;
    theme: MobileTheme;
    tool: ToolCall;
}) => {
    const presentation = describeAgentTool(tool);
    return (
        <Pressable
            accessibilityLabel={`${presentation.label} ${presentation.subject ?? ''}. ${tool.status}. Open detail.`}
            accessibilityRole="button"
            onPress={() => onPress(tool)}
            style={({ pressed }) => [
                styles.toolRow,
                pressed ? { backgroundColor: theme.surface } : null,
            ]}
            testID={`conversation-tool-${tool.id}`}
        >
            <ConversationToolIcon kind={presentation.kind} status={tool.status} theme={theme} />
            <Text numberOfLines={1} style={[styles.toolLabel, { color: theme.muted }]}>
                {presentation.label}
            </Text>
            {presentation.subject ? (
                presentation.isCodeSubject ? (
                    <View style={styles.toolChipSlot}>
                        <View style={[styles.toolChip, { backgroundColor: theme.surface }]}>
                            <Text
                                numberOfLines={1}
                                style={[styles.toolChipText, { color: theme.text }]}
                            >
                                {presentation.subject}
                            </Text>
                        </View>
                    </View>
                ) : (
                    <Text numberOfLines={1} style={[styles.toolSubject, { color: theme.text }]}>
                        {presentation.subject}
                    </Text>
                )
            ) : (
                <View style={styles.toolSpacer} />
            )}
            {tool.status === 'failed' ? <CircleAlert color={theme.danger} size={15} /> : null}
            {tool.durationMs !== undefined ? (
                <Text style={[styles.toolDuration, { color: theme.muted }]}>
                    {formatShortDuration(tool.durationMs)}
                </Text>
            ) : null}
        </Pressable>
    );
};
