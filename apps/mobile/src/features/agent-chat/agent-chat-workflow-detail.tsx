/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatWorkflow, AgentChatWorkflowMember } from '@caxri/protocol';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';

import { SectionLabel } from '../../components/section-label';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { AgentChatTaskReadContent, AgentChatTaskStatusGlyph } from './agent-chat-task-content';
import { agentChatTaskDetailContent } from './agent-chat-tasks';
import type { AgentChatWorkflowMemberRow } from './agent-chat-workflow';
import {
    agentChatWorkflowMemberRow,
    agentChatWorkflowMemberTask,
    agentChatWorkflowSections,
    agentChatWorkflowSummary,
} from './agent-chat-workflow';
import { useAgentChatTaskDetail } from './use-agent-chat-task-detail';

/**
 * A workflow run's part of its task detail, as Desktop's workflow tab lays it out for a narrow screen: the run's
 * counts, an interruption or script error, its members under each phase with their status, and the script's result once
 * it finished. A member that can be opened shows its own messages in place, with Back to the run, so the same body
 * works in the Background work sheet and in the timeline row's detail.
 */
export const AgentChatWorkflowDetail = ({
    isRunning,
    terminalId,
    theme,
    title,
    workflow,
}: {
    isRunning: boolean;
    terminalId: string;
    theme: MobileTheme;
    /**
     * The run's name, for the member view's Back.
     */
    title: string;
    workflow: AgentChatWorkflow;
}) => {
    const { t } = useTranslation();
    // The opened member is kept as it was when tapped: a large running run's outline can drop to its compact form (no
    // task ids) mid-read, and looking the member up only by task id would then jump back to the list unasked. Its live
    // entry still wins while the outline names it.
    const [opened, setOpened] = useState<
        { taskId: string; member: AgentChatWorkflowMember } | undefined
    >();
    if (opened)
        return (
            <WorkflowMember
                member={
                    workflow.members.find((member) => member.taskId === opened.taskId) ??
                    opened.member
                }
                onBack={() => setOpened(undefined)}
                taskId={opened.taskId}
                terminalId={terminalId}
                theme={theme}
                title={title}
            />
        );
    const open = (taskId: string): void => {
        const member = workflow.members.find((candidate) => candidate.taskId === taskId);
        if (member) setOpened({ taskId, member });
    };
    const sections = agentChatWorkflowSections(workflow, t);
    return (
        <View style={styles.root} testID="agent-chat-workflow">
            <Text
                style={[styles.meta, { color: theme.muted }]}
                testID="agent-chat-workflow-summary"
            >
                {agentChatWorkflowSummary(workflow, t)}
            </Text>
            {workflow.isInterrupted ? (
                <Text style={[styles.meta, { color: theme.warning }]}>
                    {t('chat.tasks.workflow.interrupted')}
                </Text>
            ) : null}
            {workflow.error ? (
                <View style={styles.block}>
                    <Text style={[styles.heading, { color: theme.danger }]}>
                        {t('chat.tasks.workflow.scriptError')}
                    </Text>
                    <Text selectable style={[styles.meta, { color: theme.text }]}>
                        {workflow.error}
                    </Text>
                </View>
            ) : null}
            {isRunning && sections.length === 0 ? (
                <Text style={[styles.meta, { color: theme.muted }]}>
                    {t('chat.tasks.workflow.starting')}
                </Text>
            ) : null}
            {sections.map((section) => (
                <View key={section.key}>
                    {section.title === undefined ? null : (
                        <View style={styles.phase}>
                            <SectionLabel style={styles.phaseTitle} theme={theme}>
                                {section.title.toUpperCase()}
                            </SectionLabel>
                            <Text style={[styles.count, { color: theme.muted }]}>
                                {section.progress}
                            </Text>
                        </View>
                    )}
                    {section.members.map((row) => (
                        <MemberRow key={row.key} onOpen={open} row={row} theme={theme} />
                    ))}
                </View>
            ))}
            {workflow.result ? (
                <View style={styles.block}>
                    <Text style={[styles.heading, { color: theme.text }]}>
                        {t('chat.tasks.workflow.result')}
                    </Text>
                    <Text
                        selectable
                        style={[styles.body, { color: theme.text }]}
                        testID="agent-chat-workflow-result"
                    >
                        {workflow.result}
                    </Text>
                </View>
            ) : null}
        </View>
    );
};

/**
 * One member: its status glyph (or `Waiting` while queued), its label, and a chevron when it can be opened.
 */
const MemberRow = ({
    onOpen,
    row,
    theme,
}: {
    onOpen: (taskId: string) => void;
    row: AgentChatWorkflowMemberRow;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { taskId } = row;
    const content = (
        <>
            <View style={styles.glyph}>
                {row.glyphStatus ? (
                    <AgentChatTaskStatusGlyph status={row.glyphStatus} theme={theme} />
                ) : null}
            </View>
            <Text numberOfLines={1} style={[styles.memberTitle, { color: theme.text }]}>
                {row.title}
            </Text>
            {row.glyphStatus ? null : (
                <Text style={[styles.count, { color: theme.muted }]}>{row.statusLabel}</Text>
            )}
            {taskId === undefined ? null : <ChevronRight color={theme.muted} size={16} />}
        </>
    );
    if (taskId === undefined)
        return (
            <View
                accessibilityLabel={row.accessibilityLabel}
                accessible
                style={styles.member}
                testID="agent-chat-workflow-member"
            >
                {content}
            </View>
        );
    return (
        <Pressable
            accessibilityHint={t('chat.tasks.workflow.openMemberHint')}
            accessibilityLabel={row.accessibilityLabel}
            accessibilityRole="button"
            onPress={() => onOpen(taskId)}
            style={({ pressed }) => [
                styles.member,
                { backgroundColor: pressed ? theme.elevated : 'transparent' },
            ]}
            testID="agent-chat-workflow-member"
        >
            {content}
        </Pressable>
    );
};

/**
 * One member's own messages, read under its `workflow:<run>:<agent>` task id and re-read while it works, with Back to
 * the run above them.
 */
const WorkflowMember = ({
    member,
    onBack,
    taskId,
    terminalId,
    theme,
    title,
}: {
    member: AgentChatWorkflowMember;
    onBack: () => void;
    taskId: string;
    terminalId: string;
    theme: MobileTheme;
    title: string;
}) => {
    const { t } = useTranslation();
    const task = agentChatWorkflowMemberTask(member, taskId);
    const row = agentChatWorkflowMemberRow(member, t);
    const { detail, isError, isLoading } = useAgentChatTaskDetail(terminalId, task);
    const content = detail ? agentChatTaskDetailContent(task, detail, t) : undefined;
    const backLabel = t('chat.tasks.workflow.backTo', { title });
    return (
        <View style={styles.root} testID="agent-chat-workflow-member-detail">
            <Pressable
                accessibilityLabel={backLabel}
                accessibilityRole="button"
                onPress={onBack}
                style={styles.back}
                testID="agent-chat-workflow-member-back"
            >
                <ChevronLeft color={theme.primary} size={18} />
                <Text numberOfLines={1} style={[styles.backText, { color: theme.primary }]}>
                    {backLabel}
                </Text>
            </Pressable>
            <View
                accessibilityLabel={row.accessibilityLabel}
                accessible
                style={styles.memberHeader}
            >
                <View style={styles.glyph}>
                    {row.glyphStatus ? (
                        <AgentChatTaskStatusGlyph status={row.glyphStatus} theme={theme} />
                    ) : null}
                </View>
                <Text style={[styles.memberTitle, styles.heading, { color: theme.text }]}>
                    {row.title}
                </Text>
                <Text style={[styles.count, { color: theme.muted }]}>{row.statusLabel}</Text>
            </View>
            <AgentChatTaskReadContent
                content={content}
                isError={isError}
                isLoading={isLoading}
                theme={theme}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    root: { gap: mobileSpace.md },
    meta: { ...mobileType.meta, fontVariant: ['tabular-nums'] },
    body: { ...mobileType.body },
    heading: { ...mobileType.bodyStrong },
    block: { gap: mobileSpace.xs },
    phase: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingHorizontal: mobileSpace.xs,
        paddingTop: mobileSpace.sm,
    },
    phaseTitle: { flex: 1 },
    count: { ...mobileType.caption, fontVariant: ['tabular-nums'] },
    member: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.sm,
    },
    memberHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.md },
    glyph: { alignItems: 'center', width: 16 },
    memberTitle: { ...mobileType.body, flex: 1, minWidth: 0 },
    back: {
        alignItems: 'center',
        alignSelf: 'flex-start',
        flexDirection: 'row',
        gap: mobileSpace.xs,
        minHeight: mobileControl.row,
    },
    backText: { ...mobileType.bodyStrong },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
