import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { ConversationEntry } from './conversation-model';
import { formatConversationDuration } from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationToolRow } from './conversation-tool-row';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;
type ToolGroup = Extract<ConversationEntry, { type: 'toolGroup' }>;

export const ConversationToolGroup = ({
    group,
    onToolPress,
    theme,
}: {
    group: ToolGroup;
    onToolPress: (tool: ToolCall) => void;
    theme: MobileTheme;
}) => {
    const [expanded, setExpanded] = useState(false);
    const Chevron = expanded ? ChevronDown : ChevronRight;
    return (
        <View style={[styles.toolGroup, { borderColor: theme.border }]}>
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((current) => !current)}
                style={styles.toolRow}
                testID={`conversation-group-${group.tools[0].id}`}
            >
                <View style={styles.toolIcon}>
                    <Chevron color={theme.muted} size={16} />
                </View>
                <Text numberOfLines={1} style={[styles.toolSummary, { color: theme.text }]}>
                    {group.summary}
                </Text>
                {group.durationMs !== undefined ? (
                    <Text style={[styles.toolDuration, { color: theme.muted }]}>
                        {formatConversationDuration(group.durationMs)}
                    </Text>
                ) : null}
            </Pressable>
            {expanded ? (
                <View style={[styles.toolChildren, { borderColor: theme.border }]}>
                    {group.tools.map((tool) => (
                        <ConversationToolRow
                            key={tool.id}
                            onPress={onToolPress}
                            theme={theme}
                            tool={tool}
                        />
                    ))}
                </View>
            ) : null}
        </View>
    );
};
