import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentAction } from '@caxri/protocol';
import { agentChatMenuGroupHeading } from '@caxri/protocol';

import { Spinner } from '../../components/spinner';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatSkillNotice } from './agent-chat-commands';
import { agentChatMenuStyles } from './agent-chat-menu-styles';

const rowHint = (action: AgentAction, t: Translate): string =>
    action.kind !== 'command'
        ? t('chat.commands.skillHint')
        : t(action.argumentHint ? 'chat.commands.commandArgumentsHint' : 'chat.commands.runHint');

const AgentChatMenuRow = ({
    action,
    hasDivider,
    index,
    isEnabled,
    onChoose,
    theme,
}: {
    action: AgentAction;
    hasDivider: boolean;
    index: number;
    isEnabled: boolean;
    onChoose: (action: AgentAction) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <Pressable
            accessibilityHint={rowHint(action, t)}
            accessibilityLabel={`${action.invocation}${action.description ? `, ${action.description}` : ''}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: !isEnabled }}
            disabled={!isEnabled}
            onPress={() => onChoose(action)}
            style={({ pressed }) => [
                agentChatMenuStyles.row,
                hasDivider && {
                    borderColor: theme.border,
                    borderTopWidth: StyleSheet.hairlineWidth,
                },
                pressed && { backgroundColor: theme.elevated },
            ]}
            testID={`agent-chat-command-${index}`}
        >
            <Text numberOfLines={1} style={[agentChatMenuStyles.name, { color: theme.text }]}>
                {action.invocation}
                {action.argumentHint ? (
                    <Text style={{ color: theme.muted, fontWeight: '400' }}>
                        {` ${action.argumentHint}`}
                    </Text>
                ) : null}
            </Text>
            {action.description ? (
                <Text
                    numberOfLines={1}
                    style={[agentChatMenuStyles.detail, { color: theme.muted }]}
                >
                    {action.description}
                </Text>
            ) : null}
        </Pressable>
    );
};

/**
 * The menu above the Chat input while the draft is a bare `/name` or `$name`, like Desktop's command menu: the
 * provider's commands under Commands and the discovered skills under Skills, in the order `agentChatMenuMatches` ranks
 * them. A row shows the invocation with its argument placeholder and its description. `notice` is a quiet status line
 * about skills (still loading, or the Agent is not running). With no match the menu stays open on Desktop's `No
 * matching command or skill`, which turns into the send-as-text confirmation after a first Send. The list scrolls past
 * a few rows so it stays above the keyboard; nothing renders when no menu should show and there is no notice.
 */
export const AgentChatCommandList = ({
    confirmsSendAsText,
    isEnabled,
    matches,
    notice,
    onChoose,
    theme,
}: {
    /**
     * A first Send on a `/name` nothing matches was held; a second Send on the same draft sends it as text.
     */
    confirmsSendAsText: boolean;
    isEnabled: boolean;
    matches: readonly AgentAction[] | undefined;
    notice: AgentChatSkillNotice | undefined;
    onChoose: (action: AgentAction) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (notice === undefined && matches === undefined) return null;
    const rows = matches ?? [];
    const missNote =
        notice === undefined && matches?.length === 0
            ? t(confirmsSendAsText ? 'chat.commands.sendAsText' : 'chat.commands.noMatch')
            : undefined;
    return (
        <View
            accessibilityLabel={t('chat.commands.label')}
            style={[
                agentChatMenuStyles.list,
                { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
            testID="agent-chat-command-list"
        >
            <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- `agentChatDraftMatches` caps the filtered menu at 50 rows. */}
                {rows.map((action, index) => {
                    const heading = agentChatMenuGroupHeading(rows, index);
                    return (
                        <View key={`${action.kind}:${action.invocation}`}>
                            {heading ? (
                                <Text
                                    accessibilityRole="header"
                                    style={[
                                        agentChatMenuStyles.heading,
                                        { color: theme.muted },
                                        index > 0 && {
                                            borderColor: theme.border,
                                            borderTopWidth: StyleSheet.hairlineWidth,
                                        },
                                    ]}
                                >
                                    {t(
                                        heading === 'Commands'
                                            ? 'chat.commands.commands'
                                            : 'chat.commands.skills',
                                    )}
                                </Text>
                            ) : null}
                            <AgentChatMenuRow
                                action={action}
                                hasDivider={heading === undefined}
                                index={index}
                                isEnabled={isEnabled}
                                onChoose={onChoose}
                                theme={theme}
                            />
                        </View>
                    );
                })}
                {missNote ? (
                    <View style={agentChatMenuStyles.notice}>
                        <Text
                            accessibilityLiveRegion="polite"
                            style={[agentChatMenuStyles.noticeText, { color: theme.muted }]}
                            testID="agent-chat-command-note"
                        >
                            {missNote}
                        </Text>
                    </View>
                ) : null}
                {notice ? (
                    <View
                        accessibilityLiveRegion="polite"
                        style={[
                            agentChatMenuStyles.notice,
                            rows.length > 0 && {
                                borderColor: theme.border,
                                borderTopWidth: StyleSheet.hairlineWidth,
                            },
                        ]}
                        testID="agent-chat-skill-notice"
                    >
                        {notice.isLoading ? <Spinner color={theme.muted} /> : null}
                        <Text style={[agentChatMenuStyles.noticeText, { color: theme.muted }]}>
                            {notice.text}
                        </Text>
                    </View>
                ) : null}
            </ScrollView>
        </View>
    );
};
