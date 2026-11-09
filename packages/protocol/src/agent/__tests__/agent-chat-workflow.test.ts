import { describe, expect, it } from 'vitest';

import {
    agentChatTaskWorkflow,
    agentChatWorkflowAgentKind,
    agentChatWorkflowCurrentPhase,
    agentChatWorkflowMemberTaskId,
    agentChatWorkflowPhaseGroups,
    agentChatWorkflowProgressLabel,
    agentChatWorkflowSibling,
    parseAgentChatWorkflowMemberTaskId,
} from '../workflow/agent-chat-workflow.js';
import type { AgentChatWorkflow } from '../workflow/agent-chat-workflow-contract.js';

const workflow: AgentChatWorkflow = {
    phases: [{ title: 'Inspect' }, { title: 'Review' }, { title: 'Fix' }],
    members: [
        { index: 3, label: 'review:b', phase: 'Review', status: 'queued', taskId: 'workflow:r:c' },
        {
            index: 1,
            label: 'inspect',
            phase: 'Inspect',
            status: 'completed',
            taskId: 'workflow:r:a',
        },
        { index: 2, label: 'review:a', phase: 'Review', status: 'running', taskId: 'workflow:r:b' },
        { index: 4, label: 'loose', status: 'failed' },
    ],
};

describe('workflow presentation', () => {
    it('groups members by declared phase, keeping empty phases and unphased members last', () => {
        const groups = agentChatWorkflowPhaseGroups(workflow);
        expect(groups.map((group) => [group.title, group.members.map((m) => m.label)])).toEqual([
            ['Inspect', ['inspect']],
            ['Review', ['review:a', 'review:b']],
            ['Fix', []],
            [undefined, ['loose']],
        ]);
        expect(groups[1]?.counts).toMatchObject({ total: 2, running: 1, queued: 1 });
    });

    it('names the phase that is running', () => {
        expect(agentChatWorkflowCurrentPhase(workflow)?.title).toBe('Review');
    });

    it('steps through openable members in run order', () => {
        expect(agentChatWorkflowSibling(workflow, 'workflow:r:a', 1)?.label).toBe('review:a');
        expect(agentChatWorkflowSibling(workflow, 'workflow:r:a', -1)).toBeUndefined();
        expect(agentChatWorkflowSibling(workflow, 'workflow:r:c', 1)).toBeUndefined();
    });

    it('round-trips member task ids and refuses path-like parts', () => {
        const id = agentChatWorkflowMemberTaskId('wf_1-a', 'a9');
        expect(id && parseAgentChatWorkflowMemberTaskId(id)).toEqual({
            runId: 'wf_1-a',
            agentId: 'a9',
        });
        expect(agentChatWorkflowMemberTaskId('../x', 'a9')).toBeUndefined();
        expect(parseAgentChatWorkflowMemberTaskId('workflow:../x:a9')).toBeUndefined();
    });

    it('tells ordinary, built-in, and custom agents apart', () => {
        expect(agentChatWorkflowAgentKind(undefined)).toBe('ordinary');
        expect(agentChatWorkflowAgentKind('workflow-subagent')).toBe('ordinary');
        expect(agentChatWorkflowAgentKind('Explore')).toBe('explore');
        expect(agentChatWorkflowAgentKind('Plan')).toBe('plan');
        expect(agentChatWorkflowAgentKind('claude-code-guide')).toBe('builtIn');
        expect(agentChatWorkflowAgentKind('code-reviewer')).toBe('custom');
    });
});

describe('agentChatTaskWorkflow', () => {
    it('prefers the live run and fills its result and error from the run record', () => {
        const live: AgentChatWorkflow = { runId: 'wf_1', phases: [], members: [] };
        const recorded: AgentChatWorkflow = { ...live, result: 'done', error: 'boom' };
        expect(agentChatTaskWorkflow({ workflow: live }, { workflow: recorded })).toEqual(recorded);
        expect(
            agentChatTaskWorkflow({ workflow: { ...live, result: 'live' } }, { workflow: recorded })
                ?.result,
        ).toBe('live');
        expect(agentChatTaskWorkflow(undefined, { workflow: recorded })).toBe(recorded);
        expect(agentChatTaskWorkflow({}, undefined)).toBeUndefined();
    });

    it("names a compact live run's members from the record, keeping their live status", () => {
        const live: AgentChatWorkflow = {
            runId: 'wf_1',
            phases: [{ title: 'Review' }],
            members: [
                { index: 0, label: '', phase: 'Review', status: 'running' },
                { index: 1, label: '', phase: 'Review', status: 'queued' },
            ],
        };
        const recorded: AgentChatWorkflow = {
            ...live,
            members: [
                {
                    index: 0,
                    label: 'review:a',
                    phase: 'Review',
                    status: 'completed',
                    taskId: 'workflow:wf_1:a',
                    agentType: 'Explore',
                },
            ],
        };
        expect(agentChatTaskWorkflow({ workflow: live }, { workflow: recorded })?.members).toEqual([
            {
                index: 0,
                label: 'review:a',
                phase: 'Review',
                status: 'running',
                taskId: 'workflow:wf_1:a',
                agentType: 'Explore',
            },
            { index: 1, label: '', phase: 'Review', status: 'queued' },
        ]);
    });
});

const progressPhases = [{ title: 'Inspect' }, { title: 'Review' }];

describe('agentChatWorkflowProgressLabel', () => {
    it('counts the running phase while the run works and the whole run after it ends', () => {
        const workflow: AgentChatWorkflow = {
            phases: progressPhases,
            members: [
                { index: 0, label: 'm0', status: 'completed', phase: 'Inspect' },
                { index: 1, label: 'm1', status: 'running', phase: 'Review' },
                { index: 2, label: 'm2', status: 'failed', phase: 'Review' },
                { index: 3, label: 'm3', status: 'queued', phase: 'Review' },
            ],
        };
        expect(agentChatWorkflowProgressLabel(workflow, true)).toEqual({
            phase: 'Review',
            done: 1,
            total: 3,
            failed: 1,
            stopped: 0,
        });
        expect(agentChatWorkflowProgressLabel(workflow, false)).toMatchObject({
            phase: undefined,
            done: 2,
            total: 4,
        });
    });

    it('shows nothing before the first member starts', () => {
        expect(
            agentChatWorkflowProgressLabel({ phases: progressPhases, members: [] }, true),
        ).toBeUndefined();
    });
});
