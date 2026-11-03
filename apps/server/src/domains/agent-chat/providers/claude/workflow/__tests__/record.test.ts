import { describe, expect, it } from 'vitest';

import {
    claudeWorkflowRunIdFromText,
    mergeClaudeWorkflow,
    parseClaudeWorkflowProgress,
    parseClaudeWorkflowRecord,
} from '../record';

const agent = (fields: Record<string, unknown>) => ({
    type: 'workflow_agent',
    index: 1,
    label: 'review:security',
    phaseTitle: 'Review',
    agentId: 'a1b2',
    ...fields,
});

describe('Claude workflow progress', () => {
    it('maps phases and members, keying each member by run and agent id', () => {
        const parsed = parseClaudeWorkflowProgress(
            [
                { type: 'workflow_phase', index: 1, title: 'Review' },
                agent({ state: 'running', startedAt: 10, tokens: 500, toolCalls: 3 }),
                agent({ index: 2, agentId: '../escape', state: 'queued' }),
                { type: 'unknown' },
                'junk',
            ],
            'wf_1',
        );
        expect(parsed.phases).toEqual([{ title: 'Review' }]);
        expect(parsed.members[0]).toMatchObject({
            index: 1,
            taskId: 'workflow:wf_1:a1b2',
            status: 'running',
            usage: { totalTokens: 500, toolUses: 3 },
        });
        // An agent id that could leave the run folder is never turned into an openable key.
        expect(parsed.members[1]?.taskId).toBeUndefined();
    });

    it('never moves a settled member back to running and never lowers a counter', () => {
        const first = mergeClaudeWorkflow(
            { phases: [], members: [] },
            parseClaudeWorkflowProgress(
                [agent({ state: 'done', tokens: 900, startedAt: 1 })],
                'wf_1',
            ),
        );
        const late = mergeClaudeWorkflow(
            first,
            parseClaudeWorkflowProgress(
                [agent({ state: 'running', tokens: 400, startedAt: 1 })],
                'wf_1',
            ),
        );
        expect(late.members[0]).toMatchObject({ status: 'completed', usage: { totalTokens: 900 } });
        expect(late.runId).toBeUndefined();
    });

    it('reads the run id from the Workflow tool result', () => {
        expect(
            claudeWorkflowRunIdFromText(
                'Workflow launched in background. Task ID: w1\nTranscript dir: /c/p/s/subagents/workflows/wf_d6c8-1cc\n',
            ),
        ).toBe('wf_d6c8-1cc');
        expect(claudeWorkflowRunIdFromText('no run here')).toBeUndefined();
    });
});

describe('Claude workflow run record', () => {
    it('stops the members a killed run left running and keeps its result as text', () => {
        const record = parseClaudeWorkflowRecord(
            {
                status: 'killed',
                result: { verdict: 'partial' },
                phases: [{ title: 'Review', detail: 'three lenses' }],
                workflowProgress: [agent({ state: 'running', startedAt: 1 })],
                totalTokens: 10,
            },
            'wf_1',
        );
        expect(record.status).toBe('stopped');
        expect(record.workflow.phases).toEqual([{ title: 'Review', detail: 'three lenses' }]);
        expect(record.workflow.members[0]?.status).toBe('stopped');
        expect(record.workflow.result).toContain('"verdict": "partial"');
        expect(record.usage).toEqual({ totalTokens: 10 });
    });

    it('reports a record that never ended without a status', () => {
        expect(parseClaudeWorkflowRecord({ status: 'running' }, 'wf_1').status).toBeUndefined();
    });
});
