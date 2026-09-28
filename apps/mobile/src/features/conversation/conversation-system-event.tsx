import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';
import type { LucideProps } from 'lucide-react-native';
import {
    Bell,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    CircleCheck,
    CircleSlash,
    Info,
    LoaderCircle,
    SquareSlash,
    SquareTerminal,
} from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';

type SystemEvent = Extract<AgentTimelineItem, { type: 'systemEvent' }>;

const eventIcon = (
    event: SystemEvent,
    theme: MobileTheme,
): { Icon: React.ComponentType<LucideProps>; color: string } => {
    if (event.kind === 'taskNotification')
        switch (event.status) {
            case 'completed':
                return { Icon: CircleCheck, color: theme.success };
            case 'failed':
                return { Icon: CircleAlert, color: theme.danger };
            case 'killed':
                return { Icon: CircleSlash, color: theme.muted };
            case 'running':
                return { Icon: LoaderCircle, color: theme.muted };
            default:
                return { Icon: Bell, color: theme.muted };
        }
    if (event.kind === 'slashCommand') return { Icon: SquareSlash, color: theme.muted };
    if (event.kind === 'bashCommand') return { Icon: SquareTerminal, color: theme.muted };
    return { Icon: Info, color: theme.muted };
};

const eventLabel: Record<SystemEvent['kind'], string> = {
    bashCommand: 'Shell command',
    caveat: 'Note',
    slashCommand: 'Command',
    taskNotification: 'Background task',
};

/**
 * Harness-injected turns (background task results, command echoes) are not the reader's own words, so they render as a
 * quiet full-width event row instead of a user bubble. Detail stays collapsed until asked for.
 */
export const ConversationSystemEvent = ({
    event,
    theme,
}: {
    event: SystemEvent;
    theme: MobileTheme;
}) => {
    const [isExpanded, setExpanded] = useState(false);
    const [isTruncated, setTruncated] = useState(false);
    const { Icon, color } = eventIcon(event, theme);
    const hasDetail = event.detail !== undefined;
    /**
     * A long summary cut to one line (a `/rename` with its full title) is only readable expanded, so it expands even
     * without detail.
     */
    const canExpand = hasDetail || isTruncated;
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    return (
        <View style={styles.message} testID={`conversation-event-${event.id}`}>
            <Pressable
                accessibilityLabel={`${eventLabel[event.kind]}${event.status ? `, ${event.status}` : ''}: ${event.summary}`}
                accessibilityRole={canExpand ? 'button' : 'text'}
                accessibilityState={canExpand ? { expanded: isExpanded } : undefined}
                disabled={!canExpand}
                onPress={() => setExpanded((value) => !value)}
                style={[styles.eventRow, { borderColor: theme.border }]}
            >
                <Icon color={color} size={16} />
                <View style={styles.eventSummaryFrame}>
                    <Text
                        numberOfLines={isExpanded ? undefined : 1}
                        style={[styles.eventSummary, { color: theme.muted }]}
                    >
                        {event.summary}
                    </Text>
                    {/*
                     * An invisible unclamped copy at the same width reports whether the visible line is cut off; a
                     * clamped Text's own layout does not say so consistently across platforms.
                     */}
                    <Text
                        accessible={false}
                        importantForAccessibility="no-hide-descendants"
                        onTextLayout={({ nativeEvent }) =>
                            setTruncated(nativeEvent.lines.length > 1)
                        }
                        style={[styles.eventSummary, styles.eventSummaryProbe]}
                    >
                        {event.summary}
                    </Text>
                </View>
                {canExpand ? <Chevron color={theme.muted} size={16} /> : null}
            </Pressable>
            {isExpanded && hasDetail ? (
                <Text
                    selectable
                    style={[
                        styles.eventDetail,
                        { backgroundColor: theme.surface, color: theme.text },
                    ]}
                >
                    {event.detail}
                </Text>
            ) : null}
        </View>
    );
};
