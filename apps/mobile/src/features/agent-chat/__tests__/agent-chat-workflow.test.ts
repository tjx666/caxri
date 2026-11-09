import type { AgentChatWorkflow } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatWorkflowMemberRow,
    agentChatWorkflowMemberTask,
    agentChatWorkflowProgressText,
    agentChatWorkflowSections,
    agentChatWorkflowSummary,
} from '../agent-chat-workflow';

const workflow: AgentChatWorkflow = {
    phases: [{ title: 'Trace' }, { title: 'Verify' }, { title: 'Synthesize' }],
    members: [
        {
            index: 0,
            label: 'trace:a',
            phase: 'Trace',
            status: 'completed',
            taskId: 'workflow:r:a',
        },
        { index: 1, label: 'trace:b', phase: 'Trace', status: 'failed', taskId: 'workflow:r:b' },
        { index: 2, label: 'verify:a', phase: 'Verify', status: 'running', taskId: 'workflow:r:c' },
        { index: 3, label: '', phase: 'Verify', status: 'queued' },
        { index: 4, label: 'loose', status: 'stopped' },
    ],
};

describe('agentChatWorkflowProgressText', () => {
    it('counts the running phase while the run works and the whole run after, with failures', () => {
        expect(agentChatWorkflowProgressText(workflow, true)).toBe(
            'Verify 0/2 · 1 failed · 1 interrupted',
        );
        expect(agentChatWorkflowProgressText(workflow, false)).toBe(
            '3/5 · 1 failed · 1 interrupted',
        );
        expect(agentChatWorkflowProgressText({ phases: [], members: [] }, true)).toBeUndefined();
    });
});

describe('agentChatWorkflowSummary', () => {
    it('counts finished subagents of all and keeps failures in view', () => {
        expect(agentChatWorkflowSummary(workflow)).toBe('3/5 subagents · 1 failed · 1 interrupted');
    });
});

describe('agentChatWorkflowSections', () => {
    it('groups members by declared phase, skips empty phases, and puts unphased members last', () => {
        const sections = agentChatWorkflowSections(workflow);
        expect(sections.map(({ title, progress }) => [title, progress])).toEqual([
            ['Trace', '2/2'],
            ['Verify', '0/2'],
            ['Other', '1/1'],
        ]);
        expect(sections[1]?.members.map(({ title, statusLabel }) => [title, statusLabel])).toEqual([
            ['verify:a', 'Running'],
            ['Subagent 4', 'Waiting'],
        ]);
    });

    it('draws no heading when the script declared no phases', () => {
        const sections = agentChatWorkflowSections({
            phases: [],
            members: [{ index: 0, label: 'only', status: 'running' }],
        });
        expect(sections).toHaveLength(1);
        expect(sections[0]?.title).toBeUndefined();
    });
});

describe('agentChatWorkflowMemberRow', () => {
    it('opens only a member with a task id and shows Waiting instead of a spinner while queued', () => {
        expect(agentChatWorkflowMemberRow(workflow.members[2])).toEqual({
            key: '2',
            title: 'verify:a',
            glyphStatus: 'running',
            statusLabel: 'Running',
            taskId: 'workflow:r:c',
            accessibilityLabel: 'verify:a, Running',
        });
        expect(agentChatWorkflowMemberRow(workflow.members[3])).toMatchObject({
            glyphStatus: undefined,
            taskId: undefined,
        });
    });
});

describe('agentChatWorkflowMemberTask', () => {
    it('reads a queued member as running so it polls until its messages arrive', () => {
        expect(agentChatWorkflowMemberTask({ status: 'queued' }, 'workflow:r:d')).toEqual({
            id: 'workflow:r:d',
            kind: 'agent',
            status: 'running',
        });
    });
});
