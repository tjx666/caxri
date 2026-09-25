import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import type { AgentTimelineItem } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

export const ConversationToolDetail = ({
    onClose,
    theme,
    tool,
}: {
    onClose: () => void;
    theme: MobileTheme;
    tool: ToolCall | null;
}) => (
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
                    <Text numberOfLines={1} style={[styles.detailTitle, { color: theme.text }]}>
                        {tool?.summary}
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        onPress={onClose}
                        testID="tool-detail-close"
                    >
                        <Text style={[styles.detailClose, { color: theme.primary }]}>Close</Text>
                    </Pressable>
                </View>
                <ScrollView>
                    <Text selectable style={[styles.detailBody, { color: theme.text }]}>
                        {tool?.detail ?? 'No further detail is available.'}
                    </Text>
                </ScrollView>
            </View>
        </View>
    </Modal>
);
