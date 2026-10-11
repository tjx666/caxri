/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import type { AgentChatSnapshot } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { agentChatQueueCaption, agentChatQueueRows } from './agent-chat-queue';

/**
 * The follow-up messages waiting for the running turn to end, read-only above the composer, like Desktop's queue. The
 * phone cannot edit, reorder, or send a queued message early; those stay on the computer.
 */
export const AgentChatQueueList = ({
    snapshot,
    theme,
}: {
    snapshot: Pick<AgentChatSnapshot, 'queue' | 'queuePaused'> | undefined;
    theme: MobileTheme;
}) => {
    const caption = agentChatQueueCaption(snapshot);
    if (!caption) return null;
    return (
        <View style={[styles.root, { borderColor: theme.border }]} testID="agent-chat-queue">
            <Text style={[styles.caption, { color: theme.muted }]}>{caption}</Text>
            {agentChatQueueRows(snapshot).map((row) => (
                <View key={row.id} style={styles.row} testID="agent-chat-queue-item">
                    <Text numberOfLines={1} style={[styles.text, { color: theme.text }]}>
                        {row.text}
                    </Text>
                    {row.images ? (
                        <Text style={[styles.images, { color: theme.muted }]}>{row.images}</Text>
                    ) : null}
                </View>
            ))}
        </View>
    );
};

const styles = StyleSheet.create({
    root: { borderTopWidth: 1, gap: 4, paddingHorizontal: 16, paddingVertical: 8 },
    caption: { fontSize: 12, fontWeight: '700' },
    row: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    text: { flex: 1, fontSize: 14 },
    images: { fontSize: 12 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
