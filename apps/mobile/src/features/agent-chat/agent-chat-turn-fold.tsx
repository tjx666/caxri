/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChevronRight, CircleStop, CircleX } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from '../conversation/conversation-styles';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { agentChatTurnTone } from './agent-chat-timeline';

type TurnEntry = Extract<AgentChatTimelineEntry, { kind: 'turn' }>;

/**
 * A finished turn's `Worked for 2m 1s` row over a hairline, as Desktop folds a turn. Tapping it shows or hides the work
 * and commentary the turn folded; the list owns that state by turn id (`toggleAgentChatTurn`), so a recycled row never
 * opens another turn. A failed or stopped turn carries its tone in the glyph and the words. A turn with nothing to fold
 * draws the same row without the chevron, and it does not respond to taps. The tappable row spans the timeline's width
 * at 48dp, so the short label is never the only place a tap lands.
 */
export const AgentChatTurnFold = ({
    entry,
    onToggle,
    theme,
}: {
    entry: TurnEntry;
    onToggle: (turnId: string) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const tone = agentChatTurnTone(entry.status);
    const color = theme[tone];
    const ToneIcon = tone === 'danger' ? CircleX : tone === 'warning' ? CircleStop : undefined;
    const isExpanded = entry.fold === 'expanded';
    const content = (
        <>
            {ToneIcon ? <ToneIcon color={color} size={14} /> : null}
            <Text numberOfLines={1} style={[styles.label, { color }]}>
                {entry.label}
            </Text>
            {entry.fold ? (
                <ChevronRight
                    color={color}
                    size={14}
                    style={isExpanded ? styles.chevronOpen : null}
                />
            ) : null}
        </>
    );
    const testID = `agent-chat-turn-${entry.turnId}`;
    return (
        <View
            style={[conversationStyles.message, styles.root, { borderBottomColor: theme.border }]}
        >
            {entry.fold ? (
                <Pressable
                    accessibilityHint={t(isExpanded ? 'chat.turn.hideWork' : 'chat.turn.showWork')}
                    accessibilityLabel={entry.label}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isExpanded }}
                    onPress={() => onToggle(entry.turnId)}
                    style={({ pressed }) => [
                        styles.row,
                        styles.toggle,
                        pressed ? styles.pressed : null,
                    ]}
                    testID={testID}
                >
                    {content}
                </Pressable>
            ) : (
                <View style={styles.row} testID={testID}>
                    {content}
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    root: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 4 },
    row: {
        alignItems: 'center',
        alignSelf: 'flex-start',
        flexDirection: 'row',
        gap: 6,
        minHeight: 28,
    },
    toggle: { alignSelf: 'stretch', minHeight: 48 },
    pressed: { opacity: 0.6 },
    label: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
    chevronOpen: { transform: [{ rotate: '90deg' }] },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
