import type { AgentChatWorkflowMember, AgentUsageReadout } from '@caxri/protocol';
import { agentChatWorkflowCounts } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatWorkflowBilled,
    agentChatWorkflowHeaderStats,
    agentChatWorkflowMemberDetail,
    agentChatWorkflowMemberGlyphStatus,
    agentChatWorkflowMemberType,
    agentChatWorkflowPhaseDurationMs,
    agentChatWorkflowPhaseState,
    agentChatWorkflowPhaseSummary,
    agentChatWorkflowPosition,
    agentChatWorkflowResumeDraft,
    isAgentChatWorkflowMemberQuiet,
    WORKFLOW_MEMBER_QUIET_MS,
} from './agent-chat-workflow';

function member(
    index: number,
    status: AgentChatWorkflowMember['status'],
    fields: Partial<AgentChatWorkflowMember> = {},
): AgentChatWorkflowMember {
    return { index, label: `m${index}`, status, ...fields };
}

function readout(fields: Partial<AgentUsageReadout> = {}): AgentUsageReadout {
    return {
        provider: 'claude',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1_000 },
        costUsd: 0.5,
        models: ['claude-sonnet'],
        unpricedModels: [],
        ...fields,
    } as AgentUsageReadout;
}

describe('isAgentChatWorkflowMemberQuiet', () => {
    it('flags only a running member whose last step is two minutes old', () => {
        const now = 10 * WORKFLOW_MEMBER_QUIET_MS;
        const old = now - WORKFLOW_MEMBER_QUIET_MS;
        expect(
            isAgentChatWorkflowMemberQuiet(member(0, 'running', { lastProgressAt: old }), now),
        ).toBe(true);
        expect(
            isAgentChatWorkflowMemberQuiet(member(0, 'running', { lastProgressAt: now - 1 }), now),
        ).toBe(false);
        expect(isAgentChatWorkflowMemberQuiet(member(0, 'running', { startedAt: old }), now)).toBe(
            true,
        );
        expect(
            isAgentChatWorkflowMemberQuiet(member(0, 'completed', { lastProgressAt: old }), now),
        ).toBe(false);
    });
});

describe('agentChatWorkflowBilled', () => {
    it('sums every member and marks a total with an unpriced model as a lower bound', () => {
        expect(agentChatWorkflowBilled([readout(), null, readout()])).toEqual({
            totalTokens: 2_000,
            cost: '$1.00',
        });
        expect(
            agentChatWorkflowBilled([
                readout(),
                readout({ models: ['a', 'b'], unpricedModels: ['b'] }),
            ]),
        ).toMatchObject({ cost: '≥$1.00' });
        expect(agentChatWorkflowBilled([readout({ unpricedModels: ['claude-sonnet'] })])).toEqual({
            totalTokens: 1_000,
            cost: undefined,
        });
        expect(agentChatWorkflowBilled([undefined])).toBeUndefined();
    });
});

describe('agentChatWorkflowMemberType', () => {
    it('names ordinary, built-in, and custom agents apart', () => {
        expect(agentChatWorkflowMemberType({ agentType: 'workflow-subagent' }, translate)).toBe(
            'Subagent',
        );
        expect(agentChatWorkflowMemberType({ agentType: 'Explore' }, translate)).toBe(
            'Claude Code built-in · Explore',
        );
        expect(agentChatWorkflowMemberType({ agentType: 'code-reviewer' }, translate)).toBe(
            'Custom agent · code-reviewer',
        );
    });
});

describe('agentChatWorkflowMemberDetail', () => {
    it('says one thing per status', () => {
        expect(
            agentChatWorkflowMemberDetail(member(0, 'failed', { error: 'boom' }), translate),
        ).toBe('boom');
        expect(agentChatWorkflowMemberDetail(member(0, 'queued'), translate)).toBe(
            'Queued, starts when a slot frees up',
        );
        expect(
            agentChatWorkflowMemberDetail(
                member(0, 'running', { lastToolName: 'Bash', lastToolSummary: 'git status' }),
                translate,
            ),
        ).toBe('Bash git status');
        expect(agentChatWorkflowMemberDetail(member(0, 'running'), translate)).toBeUndefined();
        expect(
            agentChatWorkflowMemberDetail(
                member(0, 'completed', { resultPreview: 'ok' }),
                translate,
            ),
        ).toBe('ok');
        expect(agentChatWorkflowMemberDetail(member(0, 'stopped'), translate)).toBe('Interrupted');
    });
});

describe('agentChatWorkflowMemberGlyphStatus', () => {
    it('draws a stopped member as interrupted', () => {
        expect(agentChatWorkflowMemberGlyphStatus('stopped')).toBe('interrupted');
        expect(agentChatWorkflowMemberGlyphStatus('failed')).toBe('failed');
    });
});

describe('agentChatWorkflowHeaderStats', () => {
    const workflow = {
        members: [
            member(0, 'completed'),
            member(1, 'failed'),
            member(2, 'stopped'),
            member(3, 'running'),
        ],
    };

    it('lists counts, cost, and tokens, and drops the tokens when compact', () => {
        const billed = { totalTokens: 12_000, cost: '$0.40' };
        expect(agentChatWorkflowHeaderStats(workflow, billed, translate, { compact: false })).toBe(
            '3/4 subagents · 1 failed · 1 interrupted · $0.40 · 12k tokens',
        );
        expect(agentChatWorkflowHeaderStats(workflow, billed, translate, { compact: true })).toBe(
            '3/4 subagents · 1 failed · 1 interrupted · $0.40',
        );
    });

    it('omits what it does not know', () => {
        expect(
            agentChatWorkflowHeaderStats(
                { members: [member(0, 'completed')] },
                undefined,
                translate,
                {
                    compact: false,
                },
            ),
        ).toBe('1/1 subagents');
    });
});

describe('agentChatWorkflowPhaseState', () => {
    it('opens running and failed phases and collapses one that ended normally', () => {
        const state = (members: AgentChatWorkflowMember[]) =>
            agentChatWorkflowPhaseState(agentChatWorkflowCounts(members));
        expect(state([])).toBe('notStarted');
        expect(state([member(0, 'queued')])).toBe('running');
        expect(state([member(0, 'completed'), member(1, 'running')])).toBe('running');
        expect(state([member(0, 'completed'), member(1, 'queued')])).toBe('running');
        expect(state([member(0, 'completed'), member(1, 'failed')])).toBe('failed');
        expect(state([member(0, 'completed'), member(1, 'stopped')])).toBe('ended');
    });
});

describe('agentChatWorkflowPhaseDurationMs', () => {
    it('spans the first start to the last end', () => {
        expect(
            agentChatWorkflowPhaseDurationMs([
                member(0, 'completed', { startedAt: 1_000, usage: { durationMs: 5_000 } }),
                member(1, 'completed', { startedAt: 2_000, usage: { durationMs: 10_000 } }),
            ]),
        ).toBe(11_000);
        expect(
            agentChatWorkflowPhaseDurationMs([member(0, 'running', { startedAt: 1_000 })]),
        ).toBeUndefined();
    });
});

describe('agentChatWorkflowPhaseSummary', () => {
    it('counts done members while a phase runs, and names its size and duration once it ended', () => {
        const running = [
            member(0, 'completed', { startedAt: 0 }),
            member(1, 'running', { startedAt: 0 }),
        ];
        expect(
            agentChatWorkflowPhaseSummary(
                { counts: agentChatWorkflowCounts(running), members: running },
                'running',
                translate,
            ),
        ).toEqual(['1/2']);
        const ended = [member(0, 'completed', { startedAt: 0, usage: { durationMs: 90_000 } })];
        expect(
            agentChatWorkflowPhaseSummary(
                { counts: agentChatWorkflowCounts(ended), members: ended },
                'ended',
                translate,
            ),
        ).toEqual(['1 subagent', '1m 30s']);
    });
});

describe('agentChatWorkflowResumeDraft', () => {
    it('names the run so the Agent can resume it', () => {
        expect(agentChatWorkflowResumeDraft('review', 'wf_1')).toContain('"review" (run wf_1)');
    });
});

describe('agentChatWorkflowPosition', () => {
    it('counts only openable members in run order', () => {
        const workflow = {
            phases: [],
            members: [
                member(0, 'completed', { taskId: 'a' }),
                member(1, 'queued'),
                member(2, 'running', { taskId: 'c' }),
            ],
        };
        expect(agentChatWorkflowPosition(workflow, 'a')).toEqual({ index: 1, total: 2 });
        expect(agentChatWorkflowPosition(workflow, 'c')).toEqual({ index: 2, total: 2 });
        expect(agentChatWorkflowPosition(workflow, 'missing')).toBeUndefined();
    });
});
