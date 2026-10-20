/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { memo, use, useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AgentChatTask, AgentChatWorkItem } from '@caxri/protocol';
import {
    agentChatFileChangesStat,
    agentChatTaskActivity,
    agentChatWorkDuration,
    agentChatWorkGroupFailure,
    agentChatWorkSummaryGlyph,
    isAgentChatWorkRunning,
    summarizeAgentChatWork,
} from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffStat } from '../changes/changes-diff-stat';
import { conversationStyles } from '../conversation/conversation-styles';
import { ConversationToolGroupView } from '../conversation/conversation-tool-group';
import { ConversationStatusGlyph } from '../conversation/conversation-tool-icon';
import { ConversationToolRowView } from '../conversation/conversation-tool-row';
import {
    agentChatMcpIconUrls,
    agentChatMcpServerFor,
    AgentChatMcpServersContext,
} from './agent-chat-mcp-icons';
import { AgentChatTaskStatusGlyph } from './agent-chat-task-detail';
import { useAgentChatTaskLink } from './agent-chat-task-links';
import { agentChatTaskRow } from './agent-chat-tasks';
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
 * What a row that started a subagent says after its title: the task's own status, which outlives the tool call that
 * started it (a background subagent keeps running after its row returned), and once it ended, how long it took. A
 * running row shows no clock, so a long subagent does not redraw the timeline every second; its sheet counts up.
 */
const TaskFacts = ({ task, theme }: { task: AgentChatTask; theme: MobileTheme }) => {
    const { t } = useTranslation();
    const { elapsed, statusLabel } = agentChatTaskRow(task, task.endedAt ?? 0, t);
    const isRunning = task.status === 'running';
    return (
        <View
            accessibilityLabel={elapsed && !isRunning ? `${statusLabel}, ${elapsed}` : statusLabel}
            accessible
            style={styles.taskFacts}
        >
            <AgentChatTaskStatusGlyph status={task.status} theme={theme} />
            {elapsed && !isRunning ? (
                <Text style={[conversationStyles.toolDuration, { color: theme.muted }]}>
                    {elapsed}
                </Text>
            ) : null}
        </View>
    );
};

/**
 * The icon URLs of the MCP server a tool call belongs to; empty for any other work or a server the provider has not
 * described, whose row keeps the connector glyph.
 */
const useMcpIconUrls = (toolName: string | undefined): string[] => {
    const servers = use(AgentChatMcpServersContext);
    return useMemo(
        () =>
            toolName === undefined
                ? []
                : agentChatMcpIconUrls(agentChatMcpServerFor(servers, toolName)),
        [servers, toolName],
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
        // A background shell keeps its own row facts (`Background`, `Exit N`); a subagent's row follows its task.
        const linked = useAgentChatTaskLink(item.id)?.task;
        const task = linked?.kind === 'agent' ? linked : undefined;
        const mcpIconUrls = useMcpIconUrls(item.type === 'toolCall' ? item.name : undefined);
        const row = agentChatWorkRowPresentation(item, t, mcpIconUrls.length > 0);
        const activity = task && agentChatTaskActivity(task, t);
        return (
            <ConversationToolRowView
                accessibilityLabel={
                    activity ? `${row.accessibilityLabel} ${activity}.` : row.accessibilityLabel
                }
                activity={activity}
                isCodeSubject={row.isCodeSubject}
                isRunning={row.isRunning}
                kind={row.kind}
                mcpIconUrls={mcpIconUrls}
                onPress={() => onPress(item)}
                subject={row.subject}
                testID={`agent-chat-work-${item.id}`}
                theme={theme}
                trailing={
                    task ? (
                        <TaskFacts task={task} theme={theme} />
                    ) : row.isRunning ? null : (
                        <WorkFacts item={item} row={row} theme={theme} />
                    )
                }
                verb={row.verb}
            />
        );
    },
);

/**
 * Chat work in a stable summary, with live and failure status visible while folded. A row opens its detail in a sheet.
 */
export const AgentChatWorkGroup = ({
    id,
    rows,
    summarized,
    theme,
}: {
    id: string;
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
    const glyph = useMemo(() => agentChatWorkSummaryGlyph(summarized), [summarized]);
    const mcpIconUrls = useMcpIconUrls(glyph.mcpToolName);
    return (
        <View style={conversationStyles.message}>
            <View style={[conversationStyles.toolGroup, { borderColor: theme.border }]}>
                {first ? (
                    <ConversationToolGroupView
                        count={summarized.length}
                        duration={
                            summarized.length === 1 ? agentChatWorkDuration(first, t) : undefined
                        }
                        failure={agentChatWorkGroupFailure(summarized)}
                        id={id}
                        isRunning={summarized.some(isAgentChatWorkRunning)}
                        kind={glyph.kind}
                        mcpIconUrls={mcpIconUrls}
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
    taskFacts: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    tag: { borderRadius: 4, fontSize: 11, overflow: 'hidden', paddingHorizontal: 4 },
    exit: { fontFamily: 'monospace', fontSize: 11, fontVariant: ['tabular-nums'] },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
