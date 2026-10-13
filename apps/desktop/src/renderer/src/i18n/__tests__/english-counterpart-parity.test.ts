import type { AgentChatItem } from '@caxri/protocol';
import {
    agentChatActivity,
    agentChatApprovalChoices,
    agentChatChangeKindLabel,
    agentChatEditedFilesTitle,
    agentChatFailureMessage,
    agentChatFailureReasonSchema,
    agentChatItemStatusLabel,
    agentChatNoticeMessage,
    agentChatRequestTitle,
    agentChatTurnLabel,
    agentChatTurnSchema,
    agentChatWaitingText,
    agentToolActiveLabel,
    agentToolOutcomeLabel,
    commanderInboxKindIds,
    commanderInboxKindLabel,
    commanderInboxReplyState,
    describeAgentChatWork,
    describeAgentTool,
    gitDiffTabLabel,
    parseAgentMcpToolName,
    parseGitDiffTab,
    summarizeAgentChatWork,
    summarizeAgentToolGroup,
    trackerExcerptText,
    trackerReferenceText,
} from '@caxri/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    agentChatLocalizedChangeKindLabel,
    agentChatLocalizedEditedFilesTitle,
} from '../../features/agent-chat/agent-chat-diff-labels';
import {
    agentChatActivity as desktopAgentChatActivity,
    agentChatItemStatusLabel as desktopItemStatusLabel,
    agentChatNoticeMessage as desktopNoticeMessage,
} from '../../features/agent-chat/agent-chat-presentation';
import {
    agentChatLocalizedApprovalChoices,
    agentChatLocalizedFailureMessage,
    agentChatLocalizedRequestTitle,
    agentChatLocalizedWaitingText,
} from '../../features/agent-chat/agent-chat-request-labels';
import {
    agentChatTurnLabel as desktopTurnLabel,
    describeAgentChatWork as desktopDescribeWork,
    summarizeAgentChatWork as desktopSummarizeWork,
} from '../../features/agent-chat/agent-chat-timeline';
import {
    agentChatToolActiveLabel,
    agentChatToolGroupSummary,
    agentChatToolLabel,
    agentChatToolOutcomeLabel,
} from '../../features/agent-chat/agent-chat-tool-labels';
import {
    trackerExcerptText as desktopTrackerExcerpt,
    trackerReferenceText as desktopTrackerReference,
} from '../../features/agent-chat/agent-chat-tracker-labels';
import {
    commanderInboxKindText,
    commanderInboxReplyText,
} from '../../features/agent-commander/commander-inbox';
import { documentTabPresentation } from '../../features/editor/document-tab-presentation';
import { translate, useLocaleStore } from '..';
import {
    activitySnapshots,
    APPROVALS,
    CHANGE_KINDS,
    DIFF_TAB_PATHS,
    DURATIONS,
    ITEM_STATUSES,
    OUTCOMES,
    REQUESTS,
    TOOL_CALLS,
    TOOL_KINDS,
    TOOL_SAMPLES,
    TRACKERS,
    workGroups,
    workItems,
} from './english-counterpart-parity.fixture';

/**
 * Registry of every Desktop English counterpart of an English presentation helper in `@caxri/protocol`.
 *
 * Mobile and the CLI render the protocol helper; Desktop renders its own localized copy. Under the English locale the
 * two must agree byte for byte, so a wording or rule change on one side (a threshold, truncation, phrase order) fails
 * here instead of making Desktop silently disagree with the phone. Each row feeds both sides the same inputs, chosen to
 * reach every branch and enum member, and compares the outputs as one list so a failure names the drifting entries.
 *
 * A new localized counterpart registers a row here (docs/i18n.md).
 */

interface ParityRow {
    name: string;
    /**
     * Desktop's English output and the protocol output for the same inputs, in the same order.
     */
    run: () => { desktop: unknown[]; protocol: unknown[] };
}

/**
 * Runs both sides over the same inputs. Each side is called with the input alone, so a Desktop helper's optional `t`
 * parameter never receives the array index and the default English `translate` applies.
 */
function pair<T>(
    inputs: readonly T[],
    desktop: (input: T) => unknown,
    protocol: (input: T) => unknown,
): { desktop: unknown[]; protocol: unknown[] } {
    return {
        desktop: inputs.map((input) => desktop(input)),
        protocol: inputs.map((input) => protocol(input)),
    };
}

const ROWS: ParityRow[] = [
    {
        name: 'agentChatActivity (status line, every working phrase)',
        run: () =>
            pair(
                activitySnapshots(),
                ({ snapshot, hasConversation }) =>
                    desktopAgentChatActivity(snapshot, 'Codex', { hasConversation }),
                ({ snapshot, hasConversation }) =>
                    agentChatActivity(snapshot, 'Codex', { hasConversation }),
            ),
    },
    {
        name: 'agentChatItemStatusLabel',
        run: () => pair(ITEM_STATUSES, desktopItemStatusLabel, agentChatItemStatusLabel),
    },
    {
        name: 'agentChatNoticeMessage',
        run: () =>
            pair(
                (['compacted', 'retrying', 'error', 'answered'] as const).flatMap((kind) =>
                    [undefined, 'provider text'].map(
                        (message): Extract<AgentChatItem, { type: 'notice' }> => ({
                            id: 'n',
                            type: 'notice',
                            kind,
                            ...(message && { message }),
                        }),
                    ),
                ),
                desktopNoticeMessage,
                agentChatNoticeMessage,
            ),
    },
    {
        name: 'tool table labels (agentChatToolLabel over describeAgentTool)',
        run: () =>
            pair(
                TOOL_CALLS,
                (tool) => agentChatToolLabel(describeAgentTool(tool).label),
                (tool) => describeAgentTool(tool).label,
            ),
    },
    {
        name: 'agentToolActiveLabel',
        run: () =>
            pair(
                TOOL_KINDS.map((kind) => describeAgentTool(TOOL_SAMPLES[kind])),
                (presentation) =>
                    agentChatToolActiveLabel({
                        ...presentation,
                        label: agentChatToolLabel(presentation.label),
                    }),
                agentToolActiveLabel,
            ),
    },
    {
        name: 'agentToolOutcomeLabel',
        run: () =>
            pair(
                TOOL_KINDS.flatMap((kind) =>
                    OUTCOMES.map((outcome) => ({
                        presentation: describeAgentTool(TOOL_SAMPLES[kind]),
                        outcome,
                    })),
                ),
                ({ presentation, outcome }) =>
                    agentChatToolOutcomeLabel(
                        { ...presentation, label: agentChatToolLabel(presentation.label) },
                        outcome,
                    ),
                ({ presentation, outcome }) => agentToolOutcomeLabel(presentation, outcome),
            ),
    },
    {
        name: 'summarizeAgentToolGroup (every kind, singular and plural, first-seen order)',
        run: () =>
            pair(
                [
                    ...TOOL_KINDS.flatMap((kind) => [
                        [TOOL_SAMPLES[kind]],
                        [TOOL_SAMPLES[kind], TOOL_SAMPLES[kind]],
                    ]),
                    TOOL_KINDS.map((kind) => TOOL_SAMPLES[kind]),
                    TOOL_KINDS.toReversed().map((kind) => TOOL_SAMPLES[kind]),
                ],
                agentChatToolGroupSummary,
                summarizeAgentToolGroup,
            ),
    },
    {
        name: 'agentChatTurnLabel (every status across the duration thresholds)',
        run: () =>
            pair(
                agentChatTurnSchema.shape.status.options.flatMap((status) =>
                    DURATIONS.map((durationMs) => ({ status, durationMs })),
                ),
                (turn) => desktopTurnLabel(turn),
                agentChatTurnLabel,
            ),
    },
    {
        name: 'describeAgentChatWork',
        /**
         * An MCP call is the one deliberate difference: Desktop shows the server's icon, so its row reads as the tool
         * alone (agent-chat-mcp-presentation.test.ts), while the phone and the CLI keep the server name in the label.
         */
        run: () =>
            pair(
                workItems().filter(
                    (item) => item.type !== 'toolCall' || !parseAgentMcpToolName(item.name),
                ),
                (item) => desktopDescribeWork(item),
                describeAgentChatWork,
            ),
    },
    {
        name: 'summarizeAgentChatWork',
        run: () =>
            pair(workGroups(), (items) => desktopSummarizeWork(items), summarizeAgentChatWork),
    },
    {
        name: 'trackerReferenceText and trackerExcerptText',
        run: () =>
            pair(
                TRACKERS,
                (artifact) => [
                    desktopTrackerReference(artifact, translate),
                    desktopTrackerExcerpt(artifact, translate),
                ],
                (artifact) => [trackerReferenceText(artifact), trackerExcerptText(artifact)],
            ),
    },
    {
        name: 'agentChatEditedFilesTitle',
        run: () =>
            pair(
                [
                    [],
                    ...CHANGE_KINDS.map((kind) => [{ path: '/p/src/app.ts', kind }]),
                    [
                        { path: '/p/a.ts', kind: 'add' as const },
                        { path: '/p/b.ts', kind: 'delete' as const },
                    ],
                ],
                (files) => agentChatLocalizedEditedFilesTitle(files),
                agentChatEditedFilesTitle,
            ),
    },
    {
        name: 'agentChatChangeKindLabel',
        run: () =>
            pair(
                CHANGE_KINDS,
                (kind) => agentChatLocalizedChangeKindLabel(kind),
                agentChatChangeKindLabel,
            ),
    },
    {
        name: 'commanderInboxKindLabel',
        run: () =>
            pair(
                commanderInboxKindIds,
                (kind) => commanderInboxKindText(kind),
                commanderInboxKindLabel,
            ),
    },
    {
        name: 'commanderInboxReplyState',
        run: () =>
            pair(
                [
                    { acknowledgedSequence: 0, replies: [] },
                    { acknowledgedSequence: 1, replies: [{ sequence: 2 }] },
                    { acknowledgedSequence: 2, replies: [{ sequence: 2 }] },
                    { acknowledgedSequence: 3, replies: [{ sequence: 1 }, { sequence: 2 }] },
                ],
                (item) => commanderInboxReplyText(commanderInboxReplyState(item)),
                (item) => commanderInboxReplyState(item)?.label,
            ),
    },
    {
        name: 'gitDiffTabLabel',
        run: () =>
            pair(
                DIFF_TAB_PATHS,
                (path) => documentTabPresentation(path, {}).label,
                (path) => {
                    const tab = parseGitDiffTab(path);
                    return tab && gitDiffTabLabel(tab);
                },
            ),
    },
    {
        name: 'Agent Chat request copy (approval choices, titles, waiting text, failures)',
        run: () => {
            const choices = pair(
                APPROVALS,
                agentChatLocalizedApprovalChoices,
                agentChatApprovalChoices,
            );
            const titles = pair(
                REQUESTS,
                (request) => agentChatLocalizedRequestTitle(request, 'Codex'),
                (request) => agentChatRequestTitle(request, 'Codex'),
            );
            const waiting = pair(
                [[], ...REQUESTS.map((request) => [request])],
                (requests) => agentChatLocalizedWaitingText(requests),
                agentChatWaitingText,
            );
            const failures = pair(
                agentChatFailureReasonSchema.options,
                (reason) => agentChatLocalizedFailureMessage(reason, 'Codex'),
                (reason) =>
                    agentChatFailureMessage(reason, { providerName: 'Codex', surface: 'desktop' }),
            );
            return {
                desktop: [choices, titles, waiting, failures].flatMap(({ desktop }) => desktop),
                protocol: [choices, titles, waiting, failures].flatMap(({ protocol }) => protocol),
            };
        },
    },
];

describe('Desktop English counterparts of protocol presentation helpers', () => {
    beforeEach(() => useLocaleStore.setState({ locale: 'en' }));

    it('gives every tool kind a sample that the protocol table classifies as that kind', () => {
        for (const kind of TOOL_KINDS)
            expect(describeAgentTool(TOOL_SAMPLES[kind]).kind).toBe(kind);
    });

    it.each(ROWS)('$name matches the protocol English byte for byte', ({ run }) => {
        const { desktop, protocol } = run();
        expect(desktop.length).toBeGreaterThan(0);
        expect(desktop).toEqual(protocol);
    });

    it('translates every action label the protocol tool table produces', () => {
        const labels = TOOL_CALLS.map((tool) => describeAgentTool(tool))
            .filter(({ kind }) => !['browser', 'computer', 'mcp', 'other'].includes(kind))
            .map(({ label }) => label);
        useLocaleStore.setState({ locale: 'zh-CN' });
        const untranslated = labels.filter((label) => agentChatToolLabel(label) === label);
        expect(untranslated).toEqual([]);
    });
});
