import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatCommand } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { agentChatCommandSuggestions } from './agent-chat-commands';

const styles = StyleSheet.create({
    list: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    row: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 12, paddingVertical: 6 },
    name: { fontSize: 15, fontWeight: '600' },
    detail: { fontSize: 13 },
});

const AgentChatCommandRows = ({
    commands,
    isEnabled,
    onChoose,
    theme,
}: {
    commands: readonly AgentChatCommand[];
    isEnabled: boolean;
    onChoose: (command: AgentChatCommand) => void;
    theme: MobileTheme;
}) => (
    <View
        accessibilityLabel="Commands"
        style={[styles.list, { backgroundColor: theme.surface, borderColor: theme.border }]}
        testID="agent-chat-command-list"
    >
        {commands.map((command, index) => (
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
                key={command.name}
                onPress={() => onChoose(command)}
                style={({ pressed }) => [
                    styles.row,
                    index > 0 && {
                        borderColor: theme.border,
                        borderTopWidth: StyleSheet.hairlineWidth,
                    },
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
        ))}
    </View>
);

/**
 * The provider's slash commands matching the `/name` typed at the start of a Chat draft, or nothing when the draft is
 * not a command or `commands` is absent (none reported, or a composer that cannot send). A row shows the name with its
 * argument placeholder and the provider's description, like Desktop's command menu.
 */
export const AgentChatCommandList = ({
    commands,
    draft,
    isEnabled,
    onChoose,
    theme,
}: {
    commands: readonly AgentChatCommand[] | undefined;
    draft: string;
    isEnabled: boolean;
    onChoose: (command: AgentChatCommand) => void;
    theme: MobileTheme;
}) => {
    const suggestions = agentChatCommandSuggestions(draft, commands);
    return suggestions ? (
        <AgentChatCommandRows
            commands={suggestions}
            isEnabled={isEnabled}
            onChoose={onChoose}
            theme={theme}
        />
    ) : null;
};
