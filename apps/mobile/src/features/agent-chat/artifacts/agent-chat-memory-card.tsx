/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AgentChatMemoryArtifact } from '@caxri/protocol';
import {
    agentChatEditedFileLines,
    agentChatMemoryActionLabel,
    agentChatMemoryTitle,
    agentChatMemoryTypeLabel,
} from '@caxri/protocol';
import { useRecyclingState } from '@shopify/flash-list';
import { Brain, ChevronDown } from 'lucide-react-native';

import { Card } from '../../../components/card';
import { useTranslation } from '../../../i18n';
import { MONOSPACE_FONT } from '../../../theme/monospace';
import { mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { ChangesDiffRow } from '../../changes/changes-diff-row';
import { ChangesDiffStat } from '../../changes/changes-diff-stat';
import { diffLineNumberDigits } from '../../changes/changes-model';
import { useConversationDisclosure } from '../../conversation/conversation-disclosure';
import { ConversationMarkdown } from '../../conversation/conversation-markdown';
import { agentChatChangeRows } from '../agent-chat-file-change-rows';
import { AgentChatResultRow } from '../agent-chat-result-row';

/**
 * A memory the Agent saved, updated, or forgot this turn, as Desktop's memory card: a brain tile, the memory's one-line
 * description as the title, and its category beside what was done. A tap opens the memory in place: a new memory's
 * Markdown, or the diff of an update, whose diff alone does not hold the whole file.
 */
export const AgentChatMemoryCard = ({
    memory,
    theme,
    turnId,
}: {
    memory: AgentChatMemoryArtifact;
    theme: MobileTheme;
    turnId: string;
}) => {
    const { t } = useTranslation();
    // The timeline's FlashList recycles this row for another turn; keyed by turn and file, the card opens folded there.
    const [isExpanded, setExpanded] = useRecyclingState(false, [turnId, memory.path]);
    const disclose = useConversationDisclosure();
    // The card already names the memory, so an update opens straight to its hunks rather than a nested file header.
    const rows = useMemo(
        () =>
            isExpanded && !memory.body
                ? agentChatChangeRows(agentChatEditedFileLines(memory.file))
                : [],
        [isExpanded, memory],
    );
    const digits = useMemo(() => diffLineNumberDigits(rows), [rows]);
    const action = agentChatMemoryActionLabel(memory, t);
    const type = agentChatMemoryTypeLabel(memory, t);
    const title = agentChatMemoryTitle(memory);
    return (
        <Card padded={false} theme={theme}>
            <AgentChatResultRow
                accessibilityLabel={t(isExpanded ? 'chat.memory.hide' : 'chat.memory.show', {
                    action,
                    title,
                })}
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                onPress={() => {
                    disclose();
                    setExpanded((current) => !current);
                }}
                testID={`agent-chat-memory-${memory.name}`}
                theme={theme}
                tile={<Brain color={theme.text} size={16} />}
                trailing={
                    <View style={styles.trailing}>
                        {memory.body ? null : (
                            <Text style={mobileType.caption}>
                                <ChangesDiffStat
                                    additions={memory.file.additions}
                                    deletions={memory.file.deletions}
                                    theme={theme}
                                />
                            </Text>
                        )}
                        <ChevronDown
                            color={theme.muted}
                            size={16}
                            style={isExpanded ? styles.chevronOpen : null}
                        />
                    </View>
                }
            >
                <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>
                    {title}
                </Text>
                <Text numberOfLines={1} style={[styles.caption, { color: theme.muted }]}>
                    {type ? `${type} · ${action}` : action}
                </Text>
            </AgentChatResultRow>
            {isExpanded ? (
                <View style={styles.detail} testID={`agent-chat-memory-${memory.name}-detail`}>
                    {memory.description ? (
                        <Text
                            numberOfLines={1}
                            selectable
                            style={[styles.name, { color: theme.muted }]}
                        >
                            {memory.name}
                        </Text>
                    ) : null}
                    {memory.body ? (
                        <ConversationMarkdown isCompact text={memory.body} theme={theme} />
                    ) : (
                        <View style={[styles.diff, { borderColor: theme.border }]}>
                            {rows.map((line) => (
                                <ChangesDiffRow
                                    key={line.id}
                                    line={line}
                                    lineNumberDigits={digits}
                                    theme={theme}
                                />
                            ))}
                        </View>
                    )}
                </View>
            ) : null}
        </Card>
    );
};

const styles = StyleSheet.create({
    title: mobileType.body,
    caption: mobileType.caption,
    name: { ...mobileType.caption, fontFamily: MONOSPACE_FONT },
    chevronOpen: { transform: [{ rotate: '180deg' }] },
    trailing: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.xs },
    diff: {
        borderRadius: mobileRadius.sm,
        borderWidth: 1,
        overflow: 'hidden',
        paddingVertical: mobileSpace.xs,
    },
    detail: {
        gap: mobileSpace.sm,
        paddingBottom: mobileSpace.md,
        paddingHorizontal: mobileSpace.md,
        paddingTop: mobileSpace.sm,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
