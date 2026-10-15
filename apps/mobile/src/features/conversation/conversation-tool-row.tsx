import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { AgentTimelineItem, AgentToolKind } from '@caxri/protocol';
import {
    agentToolActiveLabel,
    agentToolLabel,
    agentToolOutcomeLabel,
    describeAgentTool,
    formatNoticeableDuration,
} from '@caxri/protocol';

import { ShimmerText } from '../../components/shimmer-text';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationStatusGlyph, ConversationToolIcon } from './conversation-tool-icon';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

/**
 * One work row: the tool's glyph, its verb, what it acted on, and trailing facts. A running row keeps its glyph and
 * reads as one line of plain text under a sweeping highlight (`Running pnpm test`), as Desktop's live rows do; a
 * settled one shows a code subject (a command, path, or pattern) in a monospace chip. Both a terminal Agent's tool rows
 * and an Agent Chat's work rows draw through this view.
 */
export const ConversationToolRowView = ({
    accessibilityLabel,
    isCodeSubject,
    isRunning,
    kind,
    onPress,
    subject,
    testID,
    theme,
    trailing,
    verb,
}: {
    accessibilityLabel: string;
    isCodeSubject: boolean;
    isRunning: boolean;
    kind: AgentToolKind;
    onPress: () => void;
    subject: string | undefined;
    testID: string;
    theme: MobileTheme;
    trailing?: ReactNode;
    verb: string;
}) => (
    <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
            styles.toolRow,
            pressed ? { backgroundColor: theme.surface } : null,
        ]}
        testID={testID}
    >
        <ConversationToolIcon kind={kind} theme={theme} />
        {isRunning ? (
            <View style={styles.toolTitle}>
                <ShimmerText
                    color={theme.muted}
                    highlightColor={theme.text}
                    textStyle={styles.toolLiveLabel}
                >
                    {subject ? `${verb} ${subject}` : verb}
                </ShimmerText>
            </View>
        ) : (
            <>
                <Text numberOfLines={1} style={[styles.toolLabel, { color: theme.muted }]}>
                    {verb}
                </Text>
                {subject ? (
                    isCodeSubject ? (
                        <View style={styles.toolChipSlot}>
                            <View style={[styles.toolChip, { backgroundColor: theme.surface }]}>
                                <Text
                                    numberOfLines={1}
                                    style={[styles.toolChipText, { color: theme.text }]}
                                >
                                    {subject}
                                </Text>
                            </View>
                        </View>
                    ) : (
                        <Text numberOfLines={1} style={[styles.toolSubject, { color: theme.text }]}>
                            {subject}
                        </Text>
                    )
                ) : (
                    <View style={styles.toolSpacer} />
                )}
            </>
        )}
        {trailing}
    </Pressable>
);

/**
 * A terminal Agent's tool call as a work row. The verb says how it ended, as Desktop's does: present tense while it
 * runs (`Running`), the outcome when it failed (`Failed to run`), else the past tense (`Ran`).
 */
export const ConversationToolRow = ({
    onPress,
    theme,
    tool,
}: {
    onPress: (tool: ToolCall) => void;
    theme: MobileTheme;
    tool: ToolCall;
}) => {
    const { t } = useTranslation();
    const presentation = describeAgentTool(tool);
    const isRunning = tool.status === 'running';
    const verb = isRunning
        ? agentToolActiveLabel(presentation, t)
        : tool.status === 'failed'
          ? agentToolOutcomeLabel(presentation, 'failed', t)
          : agentToolLabel(presentation.label, t);
    const duration = formatNoticeableDuration(tool.durationMs, t);
    return (
        <ConversationToolRowView
            accessibilityLabel={`${verb} ${presentation.subject ?? ''}. ${t('conversation.tool.openDetail')}`}
            isCodeSubject={presentation.isCodeSubject}
            isRunning={isRunning}
            kind={presentation.kind}
            onPress={() => onPress(tool)}
            subject={presentation.subject}
            testID={`conversation-tool-${tool.id}`}
            theme={theme}
            trailing={
                <>
                    {tool.status === 'failed' ? (
                        <ConversationStatusGlyph status="failed" theme={theme} />
                    ) : null}
                    {duration ? (
                        <Text style={[styles.toolDuration, { color: theme.muted }]}>
                            {duration}
                        </Text>
                    ) : null}
                </>
            }
            verb={verb}
        />
    );
};
