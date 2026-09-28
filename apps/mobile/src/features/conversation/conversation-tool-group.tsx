import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';
import { ChevronDown, ChevronRight, CircleAlert } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { ConversationEntry } from './conversation-model';
import { formatConversationDuration } from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationToolIcon } from './conversation-tool-icon';
import { ConversationToolRow } from './conversation-tool-row';
import { toolKindCounts } from './tool-presentation';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;
type ToolGroup = Extract<ConversationEntry, { type: 'toolGroup' }>;

const groupStatus = (tools: readonly ToolCall[]): ToolCall['status'] => {
    if (tools.some((tool) => tool.status === 'running')) return 'running';
    return tools.some((tool) => tool.status === 'failed') ? 'failed' : 'succeeded';
};

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
    const kinds = toolKindCounts(group.tools);
    const status = groupStatus(group.tools);
    return (
        <View style={[styles.toolGroup, { borderColor: theme.border }]}>
            <Pressable
                accessibilityLabel={`${group.summary}. ${group.tools.length} tool calls.`}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((current) => !current)}
                style={({ pressed }) => [
                    styles.toolRow,
                    pressed ? { backgroundColor: theme.surface } : null,
                ]}
                testID={`conversation-group-${group.tools[0].id}`}
            >
                {/* A failed member marks the header, so a collapsed group never hides an error. */}
                <ConversationToolIcon
                    kind={kinds.length === 1 ? kinds[0].kind : null}
                    status={status === 'failed' ? 'succeeded' : status}
                    theme={theme}
                />
                <Text
                    numberOfLines={expanded ? undefined : 1}
                    style={[styles.toolSubject, { color: theme.text }]}
                >
                    {group.summary}
                </Text>
                {status === 'failed' ? <CircleAlert color={theme.danger} size={15} /> : null}
                {group.durationMs !== undefined ? (
                    <Text style={[styles.toolDuration, { color: theme.muted }]}>
                        {formatConversationDuration(group.durationMs)}
                    </Text>
                ) : null}
                <Chevron color={theme.muted} size={16} />
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
