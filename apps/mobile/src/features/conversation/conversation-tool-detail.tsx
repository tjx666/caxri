import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { AgentTimelineItem, AgentToolKind } from '@caxri/protocol';
import { describeAgentTool } from '@caxri/protocol';

import { BottomSheet } from '../../components/bottom-sheet';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationToolIcon } from './conversation-tool-icon';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

/**
 * The bottom sheet a work row opens: the tool's glyph and title with `Close` held in place while the body scrolls.
 */
export const ConversationDetailSheet = ({
    children,
    kind,
    onClose,
    theme,
    title,
}: {
    children: ReactNode;
    kind: AgentToolKind;
    onClose: () => void;
    theme: MobileTheme;
    title: string;
}) => (
    <BottomSheet
        closeLabel="Close tool detail"
        maxHeight="65%"
        onClose={onClose}
        testID="conversation-tool-detail"
        theme={theme}
    >
        {(dismiss) => (
            <View style={styles.detailContent}>
                <View style={styles.detailHeader}>
                    <ConversationToolIcon kind={kind} theme={theme} />
                    <Text numberOfLines={2} style={[styles.detailTitle, { color: theme.text }]}>
                        {title}
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        onPress={dismiss}
                        style={styles.detailCloseButton}
                        testID="tool-detail-close"
                    >
                        <Text style={[styles.detailClose, { color: theme.primary }]}>Close</Text>
                    </Pressable>
                </View>
                <ScrollView testID="tool-detail-scroll">{children}</ScrollView>
            </View>
        )}
    </BottomSheet>
);

export const ConversationToolDetail = ({
    onClose,
    theme,
    tool,
}: {
    onClose: () => void;
    theme: MobileTheme;
    tool: ToolCall | null;
}) => {
    if (!tool) return null;
    const presentation = describeAgentTool(tool);
    return (
        <ConversationDetailSheet
            kind={presentation.kind}
            onClose={onClose}
            theme={theme}
            title={presentation.label}
        >
            {tool.summary === tool.name ? null : (
                <Text
                    selectable
                    style={[
                        styles.detailSubject,
                        { backgroundColor: theme.elevated, color: theme.text },
                    ]}
                >
                    {tool.summary}
                </Text>
            )}
            <Text selectable style={[styles.detailBody, { color: theme.text }]}>
                {tool.detail ?? 'No further detail is available.'}
            </Text>
        </ConversationDetailSheet>
    );
};
