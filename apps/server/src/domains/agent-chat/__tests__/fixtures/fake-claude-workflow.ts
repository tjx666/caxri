/**
 * The fake `review` workflow run that `fake-claude-tasks.ts` starts: its progress entries, its members' transcripts,
 * and the run record it leaves, in the shapes Claude Code 2.1.316 writes them.
 */
import { SUBAGENT_MODEL } from './fake-claude-subagent-transcript.ts';

type Json = Record<string, unknown>;

/**
 * The members of the fake `review` workflow: one per phase entry, in the shape of Claude Code's `workflow_agent`
 * progress entries. `state` moves from the first snapshot to the last as the run goes.
 */
const WORKFLOW_PHASES = ['Inspect', 'Review'];
const WORKFLOW_MEMBERS = [
    { label: 'inspect:layout', phase: 1, agentType: 'Explore', result: 'Layout is consistent.' },
    { label: 'review:correctness', phase: 2, result: 'No correctness issues found.' },
    { label: 'review:security', phase: 2, error: 'Read failed: permission denied' },
] as const;

export function workflowProgress(
    runId: string,
    step: 'running' | 'settled',
    startedAt: number,
): Json[] {
    return [
        ...WORKFLOW_PHASES.map((title, index) => ({
            type: 'workflow_phase',
            index: index + 1,
            title,
        })),
        ...WORKFLOW_MEMBERS.map((entry, index) => {
            const isSettled = step === 'settled' || index === 0;
            const isRunning = step === 'running' && index === 1;
            const state = isSettled
                ? 'error' in entry
                    ? 'error'
                    : 'done'
                : isRunning
                  ? 'running'
                  : 'queued';
            return {
                type: 'workflow_agent',
                index: index + 1,
                label: entry.label,
                phaseIndex: entry.phase,
                phaseTitle: WORKFLOW_PHASES[entry.phase - 1],
                agentId: memberAgentId(runId, index),
                ...('agentType' in entry && { agentType: entry.agentType }),
                model: SUBAGENT_MODEL,
                state,
                queuedAt: startedAt,
                ...(state !== 'queued' && {
                    startedAt,
                    lastProgressAt: startedAt,
                    tokens: 1_200 * (index + 1),
                    toolCalls: 2 + index,
                    durationMs: 40,
                    lastToolName: 'Read',
                    lastToolSummary: 'src/app.ts',
                }),
                promptPreview: `Run ${entry.label} on the change.`,
                ...(isSettled && 'result' in entry && { resultPreview: entry.result }),
                ...(isSettled && 'error' in entry && { error: entry.error }),
            };
        }),
    ];
}

function memberAgentId(runId: string, index: number): string {
    return `${runId.replaceAll(/\W/gu, '')}m${index + 1}`;
}

/**
 * Each member's conversation as `recordSubagent` writes it under `subagents/workflows/<run id>/`.
 */
export function workflowMemberTranscripts(
    runId: string,
): Array<{ agentId: string; meta: Json; messages: Json[] }> {
    return WORKFLOW_MEMBERS.map((entry, index) => {
        const agentId = memberAgentId(runId, index);
        return {
            agentId,
            meta: {
                agentType: 'agentType' in entry ? entry.agentType : 'workflow-subagent',
                description: entry.label,
                workflowPhase: WORKFLOW_PHASES[entry.phase - 1],
            },
            messages: [
                { role: 'user', content: `Run ${entry.label} on the change.` },
                {
                    role: 'assistant',
                    id: `msg_${agentId}`,
                    content: [
                        { type: 'text', text: 'result' in entry ? entry.result : entry.error },
                    ],
                },
            ],
        };
    });
}

/**
 * The run record `workflows/<run id>.json` a completed run leaves.
 */
export function workflowRunRecord(
    runId: string,
    taskId: string,
    startedAt: number,
    durationMs: number,
): Json {
    return {
        runId,
        taskId,
        workflowName: 'review',
        status: 'completed',
        result: { verdict: 'One member failed; the rest found nothing.' },
        phases: WORKFLOW_PHASES.map((title) => ({ title })),
        workflowProgress: workflowProgress(runId, 'settled', startedAt),
        totalTokens: 7_200,
        totalToolCalls: 9,
        durationMs,
    };
}
