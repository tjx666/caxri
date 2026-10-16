import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { AgentTimelineItem, AgentToolKind } from '@caxri/protocol';
import { agentToolKindCounts, formatNoticeableDuration } from '@caxri/protocol';
import { useRecyclingState } from '@shopify/flash-list';
import { ChevronDown, ChevronRight } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type { ConversationEntry } from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationStatusGlyph, ConversationToolIcon } from './conversation-tool-icon';
import { ConversationToolRow } from './conversation-tool-row';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;
type ToolGroup = Extract<ConversationEntry, { type: 'toolGroup' }>;

/**
 * A summary row that lists its rows when tapped. Live work and unsuccessful outcomes stay visible while folded.
 */
export const ConversationToolGroupView = ({
    children,
    count,
    duration,
    failure,
    id,
    isRunning,
    kind,
    summary,
    testID,
    theme,
}: {
    children: ReactNode;
    count: number;
    duration?: string | null;
    failure?: 'declined' | 'failed';
    /**
     * The group's identity. The timeline's FlashList recycles this row for another group, which opens folded.
     */
    id: string;
    isRunning?: boolean;
    /**
     * `null` marks a group mixing several kinds.
     */
    kind: AgentToolKind | null;
    summary: string;
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useRecyclingState(false, [id]);
    const Chevron = expanded ? ChevronDown : ChevronRight;
    return (
        <View>
            <Pressable
                accessibilityLabel={`${summary}. ${t(
                    count === 1
                        ? 'conversation.tool.callCountOne'
                        : 'conversation.tool.callCountOther',
                    { count },
                )}`}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((current) => !current)}
                style={({ pressed }) => [
                    styles.toolRow,
                    pressed ? { backgroundColor: theme.surface } : null,
                ]}
                testID={testID}
            >
                <ConversationToolIcon kind={kind} theme={theme} />
                <Text
                    numberOfLines={expanded ? undefined : 1}
                    style={[styles.toolSubject, { color: theme.text }]}
                >
                    {summary}
                </Text>
                {isRunning ? <ConversationStatusGlyph status="running" theme={theme} /> : null}
                {failure ? <ConversationStatusGlyph status={failure} theme={theme} /> : null}
                {duration ? (
                    <Text style={[styles.toolDuration, { color: theme.muted }]}>{duration}</Text>
                ) : null}
                <Chevron color={theme.muted} size={16} />
            </Pressable>
            {expanded ? (
                <View style={[styles.toolChildren, { borderColor: theme.border }]}>{children}</View>
            ) : null}
        </View>
    );
};

/**
 * A terminal Agent's run of settled tool calls as one summary row.
 */
export const ConversationToolGroup = ({
    group,
    onToolPress,
    theme,
}: {
    group: ToolGroup;
    onToolPress: (tool: ToolCall) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const kinds = agentToolKindCounts(group.tools);
    return (
        <View style={[styles.toolGroup, { borderColor: theme.border }]}>
            <ConversationToolGroupView
                count={group.tools.length}
                duration={formatNoticeableDuration(group.durationMs, t)}
                failure={
                    group.tools.some((tool) => tool.status === 'failed') ? 'failed' : undefined
                }
                id={group.id}
                kind={kinds.length === 1 ? (kinds[0]?.kind ?? null) : null}
                summary={group.summary}
                testID={`conversation-group-${group.tools[0]?.id ?? group.id}`}
                theme={theme}
            >
                {group.tools.map((tool) => (
                    <ConversationToolRow
                        key={tool.id}
                        onPress={onToolPress}
                        theme={theme}
                        tool={tool}
                    />
                ))}
            </ConversationToolGroupView>
        </View>
    );
};
