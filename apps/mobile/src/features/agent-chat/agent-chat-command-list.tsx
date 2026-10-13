import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatCommand } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatCommandMenu } from './agent-chat-commands';

const styles = StyleSheet.create({
    list: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    row: { justifyContent: 'center', minHeight: 48, paddingHorizontal: 12, paddingVertical: 6 },
    name: { fontSize: 15, fontWeight: '600' },
    detail: { fontSize: 13 },
    note: { fontSize: 13, lineHeight: 18 },
});

const AgentChatCommandRow = ({
    command,
    index,
    isEnabled,
    onChoose,
    theme,
}: {
    command: AgentChatCommand;
    index: number;
    isEnabled: boolean;
    onChoose: (command: AgentChatCommand) => void;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityHint={
            command.argumentHint === undefined
                ? 'Runs the command now.'
                : 'Adds the command to your message so you can type its arguments.'
        }
        accessibilityLabel={`/${command.name}${command.description ? `, ${command.description}` : ''}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: !isEnabled }}
        disabled={!isEnabled}
        onPress={() => onChoose(command)}
        style={({ pressed }) => [
            styles.row,
            index > 0 && { borderColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth },
            pressed && { backgroundColor: theme.elevated },
        ]}
        testID={`agent-chat-command-${index}`}
    >
        <Text numberOfLines={1} style={[styles.name, { color: theme.text }]}>
            {`/${command.name}`}
            {command.argumentHint ? (
                <Text style={{ color: theme.muted, fontWeight: '400' }}>
                    {` ${command.argumentHint}`}
                </Text>
            ) : null}
        </Text>
        {command.description ? (
            <Text numberOfLines={1} style={[styles.detail, { color: theme.muted }]}>
                {command.description}
            </Text>
        ) : null}
    </Pressable>
);

/**
 * The provider's slash commands matching the `/name` typed at the start of a Chat draft (`agentChatCommandMenu`), or
 * nothing when no list should show. A row shows the name with its argument placeholder and the provider's description,
 * like Desktop's command menu. Past the row cap a last row asks the user to keep typing; with no match the list stays
 * open on Desktop's `No matching command or skill`, which turns into the send-as-text confirmation after a first Send.
 */
export const AgentChatCommandList = ({
    confirmsSendAsText,
    isEnabled,
    menu,
    onChoose,
    theme,
}: {
    /**
     * A first Send on a draft no command matches was held; a second Send on the same draft sends it as text.
     */
    confirmsSendAsText: boolean;
    isEnabled: boolean;
    menu: AgentChatCommandMenu | undefined;
    onChoose: (command: AgentChatCommand) => void;
    theme: MobileTheme;
}) => {
    if (!menu) return null;
    const note =
        menu.matches.length === 0
            ? confirmsSendAsText
                ? 'No such command. Tap Send again to send as text.'
                : 'No matching command or skill'
            : menu.hasMore
              ? 'Keep typing to narrow'
              : undefined;
    return (
        <View
            accessibilityLabel="Commands"
            style={[styles.list, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="agent-chat-command-list"
        >
            {menu.matches.map((command, index) => (
                <AgentChatCommandRow
                    command={command}
                    index={index}
                    isEnabled={isEnabled}
                    key={command.name}
                    onChoose={onChoose}
                    theme={theme}
                />
            ))}
            {note ? (
                <View
                    style={[
                        styles.row,
                        menu.matches.length > 0 && {
                            borderColor: theme.border,
                            borderTopWidth: StyleSheet.hairlineWidth,
                        },
                    ]}
                >
                    <Text
                        accessibilityLiveRegion="polite"
                        style={[styles.note, { color: theme.muted }]}
                        testID="agent-chat-command-note"
                    >
                        {note}
                    </Text>
                </View>
            ) : null}
        </View>
    );
};
