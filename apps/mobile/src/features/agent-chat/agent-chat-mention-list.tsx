import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatMentionRow } from './agent-chat-mentions';
import { agentChatMentionHeading } from './agent-chat-mentions';
import { agentChatMenuStyles as styles } from './agent-chat-menu-styles';

const mentionStyles = StyleSheet.create({
    line: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    name: { flexShrink: 1 },
});

const rowLabel = (row: AgentChatMentionRow) =>
    row.kind === 'file'
        ? { detail: row.directory, name: row.name }
        : { detail: row.projectTitle, name: row.title };

/**
 * The `@` list above the Chat input, as Desktop's: Files, then Sessions, each row a name with its folder or Project
 * under it. A Session row shows a spinner while its reference file is prepared. With nothing found it says so instead
 * of vanishing, so a typo reads as a miss; a failed file search says the search is unavailable.
 */
export const AgentChatMentionList = ({
    isEnabled,
    isError,
    isSearching,
    onChoose,
    preparingSessionId,
    rows,
    theme,
}: {
    isEnabled: boolean;
    isError: boolean;
    isSearching: boolean;
    onChoose: (row: AgentChatMentionRow) => void;
    preparingSessionId: string | undefined;
    rows: readonly AgentChatMentionRow[] | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (rows === undefined) return null;
    const note = isError
        ? t('chat.mentions.searchFailed')
        : !isSearching && rows.length === 0
          ? t('chat.mentions.noMatch')
          : undefined;
    return (
        <View
            accessibilityLabel={t('chat.mentions.label')}
            style={[styles.list, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="agent-chat-mention-list"
        >
            <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- Capped at 8 files and 20 Sessions. */}
                {rows.map((row, index) => {
                    const heading = agentChatMentionHeading(rows, index);
                    const { detail, name } = rowLabel(row);
                    const isPreparing =
                        row.kind === 'session' && row.sessionId === preparingSessionId;
                    return (
                        <View
                            key={
                                row.kind === 'file'
                                    ? `file:${row.path}`
                                    : `session:${row.sessionId}`
                            }
                        >
                            {heading ? (
                                <Text
                                    accessibilityRole="header"
                                    style={[
                                        styles.heading,
                                        { color: theme.muted },
                                        index > 0 && {
                                            borderColor: theme.border,
                                            borderTopWidth: StyleSheet.hairlineWidth,
                                        },
                                    ]}
                                >
                                    {t(
                                        heading === 'file'
                                            ? 'chat.mentions.files'
                                            : 'chat.mentions.sessions',
                                    )}
                                </Text>
                            ) : null}
                            <Pressable
                                accessibilityHint={t(
                                    row.kind === 'file'
                                        ? 'chat.mentions.fileHint'
                                        : 'chat.mentions.sessionHint',
                                )}
                                accessibilityLabel={detail ? `${name}, ${detail}` : name}
                                accessibilityRole="button"
                                accessibilityState={{
                                    busy: isPreparing,
                                    disabled: !isEnabled || preparingSessionId !== undefined,
                                }}
                                disabled={!isEnabled || preparingSessionId !== undefined}
                                onPress={() => onChoose(row)}
                                style={({ pressed }) => [
                                    styles.row,
                                    heading === undefined && {
                                        borderColor: theme.border,
                                        borderTopWidth: StyleSheet.hairlineWidth,
                                    },
                                    pressed && { backgroundColor: theme.elevated },
                                ]}
                                testID={`agent-chat-mention-${index}`}
                            >
                                <View style={mentionStyles.line}>
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            styles.name,
                                            mentionStyles.name,
                                            { color: theme.text },
                                        ]}
                                    >
                                        {name}
                                    </Text>
                                    {isPreparing ? <Spinner color={theme.muted} /> : null}
                                </View>
                                {detail ? (
                                    <Text
                                        numberOfLines={1}
                                        style={[styles.detail, { color: theme.muted }]}
                                    >
                                        {detail}
                                    </Text>
                                ) : null}
                            </Pressable>
                        </View>
                    );
                })}
                {isSearching && rows.length === 0 ? (
                    <View style={styles.notice}>
                        <Spinner color={theme.muted} />
                    </View>
                ) : null}
                {note ? (
                    <View style={styles.notice}>
                        <Text
                            accessibilityLiveRegion="polite"
                            style={[styles.noticeText, { color: theme.muted }]}
                            testID="agent-chat-mention-note"
                        >
                            {note}
                        </Text>
                    </View>
                ) : null}
            </ScrollView>
        </View>
    );
};
