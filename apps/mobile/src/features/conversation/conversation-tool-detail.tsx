import { Pressable, ScrollView, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';

import { BottomSheet } from '../../components/bottom-sheet';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';
import { ConversationToolIcon } from './conversation-tool-icon';
import { describeTool } from './tool-presentation';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

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
    const presentation = describeTool(tool);
    return (
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
                        <ConversationToolIcon
                            kind={presentation.kind}
                            status={tool.status}
                            theme={theme}
                        />
                        <Text numberOfLines={1} style={[styles.detailTitle, { color: theme.text }]}>
                            {presentation.label}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            onPress={dismiss}
                            style={styles.detailCloseButton}
                            testID="tool-detail-close"
                        >
                            <Text style={[styles.detailClose, { color: theme.primary }]}>
                                Close
                            </Text>
                        </Pressable>
                    </View>
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
                    <ScrollView testID="tool-detail-scroll">
                        <Text selectable style={[styles.detailBody, { color: theme.text }]}>
                            {tool.detail ?? 'No further detail is available.'}
                        </Text>
                    </ScrollView>
                </View>
            )}
        </BottomSheet>
    );
};
