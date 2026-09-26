import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';

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
    const presentation = tool ? describeTool(tool) : null;
    return (
        <Modal animationType="slide" onRequestClose={onClose} transparent visible={tool !== null}>
            <View style={styles.detailOverlay}>
                <Pressable
                    accessibilityLabel="Close tool detail"
                    accessibilityRole="button"
                    onPress={onClose}
                    style={styles.detailBackdrop}
                />
                <View
                    style={[styles.detailSheet, { backgroundColor: theme.surface }]}
                    testID="conversation-tool-detail"
                >
                    <View style={styles.detailHeader}>
                        {tool && presentation ? (
                            <ConversationToolIcon
                                kind={presentation.kind}
                                status={tool.status}
                                theme={theme}
                            />
                        ) : null}
                        <Text numberOfLines={1} style={[styles.detailTitle, { color: theme.text }]}>
                            {presentation?.label}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            onPress={onClose}
                            testID="tool-detail-close"
                        >
                            <Text style={[styles.detailClose, { color: theme.primary }]}>
                                Close
                            </Text>
                        </Pressable>
                    </View>
                    {tool && tool.summary !== tool.name ? (
                        <Text
                            selectable
                            style={[
                                styles.detailSubject,
                                { backgroundColor: theme.elevated, color: theme.text },
                            ]}
                        >
                            {tool.summary}
                        </Text>
                    ) : null}
                    <ScrollView>
                        <Text selectable style={[styles.detailBody, { color: theme.text }]}>
                            {tool?.detail ?? 'No further detail is available.'}
                        </Text>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
};
