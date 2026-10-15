/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AgentChatWorkItem } from '@caxri/protocol';
import {
    agentChatFileChangesStat,
    agentChatWorkDuration,
    agentChatWorkGroupFailure,
    agentChatWorkKind,
    summarizeAgentChatWork,
} from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffStat } from '../changes/changes-diff-stat';
import { conversationStyles } from '../conversation/conversation-styles';
import { ConversationToolGroupView } from '../conversation/conversation-tool-group';
import { ConversationStatusGlyph } from '../conversation/conversation-tool-icon';
import { ConversationToolRowView } from '../conversation/conversation-tool-row';
import { AgentChatWorkDetail } from './agent-chat-work-detail';
import type { AgentChatWorkRowPresentation } from './agent-chat-work-row';
import { agentChatWorkRowPresentation } from './agent-chat-work-row';

/**
 * What a row says after its title, as Desktop's row does: a change's `+N -M`, a command's `Background` tag and non-zero
 * `Exit N`, how a step that did not complete ended, and a noticeable duration.
 */
const WorkFacts = ({
    item,
    row,
    theme,
}: {
    item: AgentChatWorkItem;
    row: AgentChatWorkRowPresentation;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const stat = useMemo(
        () => (item.type === 'fileChange' ? agentChatFileChangesStat(item.changes) : undefined),
        [item],
    );
    const duration = agentChatWorkDuration(item, t);
    return (
        <>
            {stat ? (
                <Text style={styles.fact}>
                    <ChangesDiffStat
                        additions={stat.additions}
                        deletions={stat.deletions}
                        theme={theme}
                    />
                </Text>
            ) : null}
            {row.background ? (
                <Text style={[styles.tag, { backgroundColor: theme.surface, color: theme.muted }]}>
                    {t('chat.work.background')}
                </Text>
            ) : null}
            {row.failedExitCode === undefined ? null : (
                <Text style={[styles.exit, { color: theme.danger }]}>
                    {t('chat.work.exit', { code: row.failedExitCode })}
                </Text>
            )}
            {item.type === 'reasoning' ? null : (
                <ConversationStatusGlyph status={item.status} theme={theme} />
            )}
            {duration ? (
                <Text style={[conversationStyles.toolDuration, { color: theme.muted }]}>
                    {duration}
                </Text>
            ) : null}
        </>
    );
};

/**
 * One piece of Chat work: its glyph, a present-tense verb under the activity highlight while it runs (`Running pnpm
 * test`, `Thinking`), else its settled verb and subject with the facts above. Memoized so a streamed reply elsewhere in
 * the turn does not redraw finished rows.
 */
const AgentChatWorkRow = memo(
    ({
        item,
        onPress,
        theme,
    }: {
        item: AgentChatWorkItem;
        onPress: (item: AgentChatWorkItem) => void;
        theme: MobileTheme;
    }) => {
        const { t } = useTranslation();
        const row = agentChatWorkRowPresentation(item, t);
        return (
            <ConversationToolRowView
                accessibilityLabel={row.accessibilityLabel}
                isCodeSubject={row.isCodeSubject}
                isRunning={row.isRunning}
                kind={row.kind}
                onPress={() => onPress(item)}
                subject={row.subject}
                testID={`agent-chat-work-${item.id}`}
                theme={theme}
                trailing={row.isRunning ? null : <WorkFacts item={item} row={row} theme={theme} />}
                verb={row.verb}
            />
        );
    },
);

/**
 * A run of Chat work in one card, split the way Desktop splits it: settled work behind one summary row (`Ran 3
 * commands, read 2 files`, with a failure glyph when any step failed or was declined), and each step still running as
 * its own live row below it. A row opens its detail in a sheet.
 */
export const AgentChatWorkGroup = ({
    rows,
    summarized,
    theme,
}: {
    rows: readonly AgentChatWorkItem[];
    summarized: readonly AgentChatWorkItem[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    /**
     * Held by id so an open sheet follows the item as its output streams in.
     */
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const select = useCallback((item: AgentChatWorkItem) => setSelectedId(item.id), []);
    const selected =
        selectedId === null
            ? null
            : (summarized.find((item) => item.id === selectedId) ??
              rows.find((item) => item.id === selectedId) ??
              null);
    const first = summarized.at(0);
    return (
        <View style={conversationStyles.message}>
            <View style={[conversationStyles.toolGroup, { borderColor: theme.border }]}>
                {first ? (
                    <ConversationToolGroupView
                        count={summarized.length}
                        failure={agentChatWorkGroupFailure(summarized)}
                        id={first.id}
                        kind={agentChatWorkKind(summarized) ?? null}
                        summary={summarizeAgentChatWork(summarized, t)}
                        testID={`agent-chat-work-group-${first.id}`}
                        theme={theme}
                    >
                        {summarized.map((item) => (
                            <AgentChatWorkRow
                                item={item}
                                key={item.id}
                                onPress={select}
                                theme={theme}
                            />
                        ))}
                    </ConversationToolGroupView>
                ) : null}
                {rows.map((item, index) => (
                    <View
                        key={item.id}
                        style={
                            first || index > 0
                                ? { borderColor: theme.border, borderTopWidth: 1 }
                                : null
                        }
                    >
                        <AgentChatWorkRow item={item} onPress={select} theme={theme} />
                    </View>
                ))}
            </View>
            <AgentChatWorkDetail
                item={selected}
                onClose={() => setSelectedId(null)}
                theme={theme}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    fact: { fontSize: 12, fontVariant: ['tabular-nums'] },
    tag: { borderRadius: 4, fontSize: 11, overflow: 'hidden', paddingHorizontal: 4 },
    exit: { fontFamily: 'monospace', fontSize: 11, fontVariant: ['tabular-nums'] },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
