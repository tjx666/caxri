import type { AgentChatTask, AgentChatWorkflow, AgentChatWorkflowMember } from '@caxri/protocol';
import {
    agentChatWorkflowMemberTaskId,
    MAX_AGENT_CHAT_WORKFLOW_MEMBERS,
    MAX_AGENT_CHAT_WORKFLOW_PHASES,
} from '@caxri/protocol';

import { clip, isRecord, stringField } from '../../../chat-items';
import { claudeTaskStatus } from '../task-fields';

/**
 * Maps a Claude Code workflow run (the `Workflow` tool, a `local_workflow` task) onto `AgentChatTask.workflow`. Two
 * sources carry the same entries, both untrusted JSON:
 *
 * - Live, `system/task_progress` frames of the run carry `workflow_progress`: `workflow_phase {index, title}` and
 *   `workflow_agent {index, label, phaseTitle, agentId, agentType, model, state, startedAt, lastProgressAt,
 *   lastToolName, lastToolSummary, promptPreview, resultPreview, error, tokens, toolCalls, durationMs}` entries;
 * - After the run, the run record `<session>/workflows/<run id>.json` keeps the last `workflowProgress` with the declared
 *   `phases`, `status`, `result`, and `error`.
 *
 * Calibrated against Claude Code 2.1.316.
 */

type Json = Record<string, unknown>;

const RUN_ID = /^[\w-]{1,100}$/u;

/**
 * The run id the `Workflow` tool result names in its transcript folder (`…/subagents/workflows/<run id>`); the tool
 * result text is the one place a live Chat and a replayed one both carry it.
 */
const TRANSCRIPT_DIR_RUN_ID = /subagents[/\\]workflows[/\\]([\w-]{1,100})/u;

export function claudeWorkflowRunIdFromText(text: string | undefined): string | undefined {
    return text ? TRANSCRIPT_DIR_RUN_ID.exec(text)?.[1] : undefined;
}

export function isClaudeWorkflowRunId(value: string | undefined): value is string {
    return value !== undefined && RUN_ID.test(value);
}

function count(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : undefined;
}

function time(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function boundedString(value: unknown, limit: number): string | undefined {
    const text = stringField(value);
    return text ? clip(text, limit) : undefined;
}

/**
 * A member's `state` as a member status. Claude Code reports `queued`, `running`, `done`, and `error`; a stopped run
 * leaves the members it interrupted in `killed`. An unknown state reads as running once the member started.
 */
function claudeWorkflowMemberStatus(
    state: unknown,
    hasStarted: boolean,
): AgentChatWorkflowMember['status'] {
    switch (state) {
        case 'queued':
        case 'pending': {
            return 'queued';
        }
        case 'running':
        case 'started': {
            return 'running';
        }
        case 'done':
        case 'completed':
        case 'success': {
            return 'completed';
        }
        case 'error':
        case 'failed': {
            return 'failed';
        }
        case 'killed':
        case 'stopped':
        case 'cancelled':
        case 'aborted': {
            return 'stopped';
        }
        default: {
            return hasStarted ? 'running' : 'queued';
        }
    }
}

function member(entry: Json, runId: string | undefined): AgentChatWorkflowMember | undefined {
    const index = count(entry.index);
    if (index === undefined) return undefined;
    const startedAt = time(entry.startedAt);
    const agentId = stringField(entry.agentId);
    const taskId = agentChatWorkflowMemberTaskId(runId, agentId);
    const totalTokens = count(entry.tokens);
    const toolUses = count(entry.toolCalls);
    const durationMs = count(entry.durationMs);
    const usage = {
        ...(totalTokens !== undefined && { totalTokens }),
        ...(toolUses !== undefined && { toolUses }),
        ...(durationMs !== undefined && { durationMs }),
    };
    const fields = {
        taskId,
        phase: boundedString(entry.phaseTitle, 200),
        agentType: boundedString(entry.agentType, 200),
        model: boundedString(entry.model, 200),
        startedAt,
        lastProgressAt: time(entry.lastProgressAt),
        lastToolName: boundedString(entry.lastToolName, 200),
        lastToolSummary: boundedString(entry.lastToolSummary, 500),
        promptPreview: boundedString(entry.promptPreview, 500),
        resultPreview: boundedString(entry.resultPreview, 2_000),
        error: boundedString(entry.error, 2_000),
        usage: Object.keys(usage).length > 0 ? usage : undefined,
    };
    return {
        index,
        label: boundedString(entry.label, 200) ?? `#${index}`,
        status: claudeWorkflowMemberStatus(entry.state, startedAt !== undefined),
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    };
}

/**
 * The phases and members a `workflow_progress` (or a run record's `workflowProgress`) array lists.
 */
export function parseClaudeWorkflowProgress(
    entries: unknown,
    runId: string | undefined,
): Pick<AgentChatWorkflow, 'members' | 'phases'> {
    const phases: AgentChatWorkflow['phases'] = [];
    const members: AgentChatWorkflowMember[] = [];
    if (!Array.isArray(entries)) return { phases, members };
    for (const entry of entries) {
        if (!isRecord(entry)) continue;
        if (entry.type === 'workflow_phase') {
            const title = boundedString(entry.title, 200);
            if (title && phases.length < MAX_AGENT_CHAT_WORKFLOW_PHASES) phases.push({ title });
        } else if (entry.type === 'workflow_agent') {
            const parsed = member(entry, runId);
            if (parsed && members.length < MAX_AGENT_CHAT_WORKFLOW_MEMBERS) members.push(parsed);
        }
    }
    return { phases, members };
}

const SETTLED = new Set<AgentChatWorkflowMember['status']>(['completed', 'failed', 'stopped']);

/**
 * Folds a newer progress report into the run as the Chat lists it. A report may list only the members that changed, and
 * frames can arrive out of order, so members merge by index, a settled member never goes back to running or queued, and
 * a counter never goes down. T3 Code guards its `workflow_progress` merge against status regression the same way.
 */
export function mergeClaudeWorkflow(
    previous: AgentChatWorkflow | undefined,
    next: Pick<AgentChatWorkflow, 'members' | 'phases'> & Partial<AgentChatWorkflow>,
): AgentChatWorkflow {
    const members = new Map((previous?.members ?? []).map((entry) => [entry.index, entry]));
    for (const incoming of next.members) {
        const prior = members.get(incoming.index);
        if (!prior) {
            if (members.size < MAX_AGENT_CHAT_WORKFLOW_MEMBERS)
                members.set(incoming.index, incoming);
            continue;
        }
        const isRegressed = SETTLED.has(prior.status) && !SETTLED.has(incoming.status);
        const usage = {
            ...prior.usage,
            ...incoming.usage,
            ...maxCount('totalTokens', prior.usage, incoming.usage),
            ...maxCount('toolUses', prior.usage, incoming.usage),
            ...maxCount('durationMs', prior.usage, incoming.usage),
        };
        members.set(incoming.index, {
            ...prior,
            ...(!isRegressed && incoming),
            ...(isRegressed && { status: prior.status }),
            ...(Object.keys(usage).length > 0 && { usage }),
        });
    }
    const phases = next.phases.length > 0 ? next.phases : (previous?.phases ?? []);
    const runId = next.runId ?? previous?.runId;
    const result = next.result ?? previous?.result;
    const error = next.error ?? previous?.error;
    const isInterrupted = next.isInterrupted ?? previous?.isInterrupted;
    return {
        ...(runId && { runId }),
        phases,
        members: members
            .values()
            .toArray()
            .toSorted((a, b) => a.index - b.index),
        ...(result !== undefined && { result }),
        ...(error !== undefined && { error }),
        ...(isInterrupted !== undefined && { isInterrupted }),
    };
}

function maxCount(
    key: 'durationMs' | 'toolUses' | 'totalTokens',
    a: AgentChatWorkflowMember['usage'],
    b: AgentChatWorkflowMember['usage'],
): Record<string, number> {
    const values = [a?.[key], b?.[key]].filter((value) => value !== undefined);
    return values.length > 0 ? { [key]: Math.max(...values) } : {};
}

/**
 * Members still running or queued when their run ended are stopped with it: Claude Code does not always report a last
 * state for the members it interrupted.
 */
export function settleClaudeWorkflow(
    workflow: AgentChatWorkflow,
    status: AgentChatTask['status'],
): AgentChatWorkflow {
    if (status === 'running') return workflow;
    return {
        ...workflow,
        members: workflow.members.map((entry) =>
            SETTLED.has(entry.status) ? entry : { ...entry, status: 'stopped' as const },
        ),
    };
}

function resultText(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value.trim() ? clip(value, 8_000) : undefined;
    try {
        return clip(JSON.stringify(value, undefined, 2), 8_000);
    } catch {
        return undefined;
    }
}

/**
 * What a run record says about its run: the workflow, the task status it ended with (`undefined` for a record that
 * never ended, which reads as interrupted), and its totals.
 */
export interface ClaudeWorkflowRecord {
    workflowName: string | undefined;
    taskId: string | undefined;
    status: AgentChatTask['status'] | undefined;
    workflow: AgentChatWorkflow;
    usage: AgentChatTask['usage'];
}

/**
 * Parses `<session>/workflows/<run id>.json`. A record whose status is still running belongs to a run whose process is
 * gone when no live task claims it; the caller decides that, so it is reported as is.
 */
export function parseClaudeWorkflowRecord(record: unknown, runId: string): ClaudeWorkflowRecord {
    const json: Json = isRecord(record) ? record : {};
    const progress = parseClaudeWorkflowProgress(json.workflowProgress, runId);
    const declared = Array.isArray(json.phases)
        ? json.phases
              .filter(isRecord)
              .flatMap((phase) => {
                  const title = boundedString(phase.title, 200);
                  const detail = boundedString(phase.detail, 500);
                  return title ? [{ title, ...(detail && { detail }) }] : [];
              })
              .slice(0, MAX_AGENT_CHAT_WORKFLOW_PHASES)
        : [];
    const status = claudeTaskStatus(json.status);
    const isSettled = status !== undefined && status !== 'running';
    const result = resultText(json.result);
    const error = resultText(json.error);
    const workflow: AgentChatWorkflow = {
        runId,
        phases: declared.length > 0 ? declared : progress.phases,
        members: progress.members,
        ...(result !== undefined && { result }),
        ...(error !== undefined && { error }),
    };
    const totalTokens = count(json.totalTokens);
    const toolUses = count(json.totalToolCalls);
    const durationMs = count(json.durationMs);
    return {
        workflowName: boundedString(json.workflowName, 1_000),
        taskId: boundedString(json.taskId, 200),
        status: isSettled ? status : undefined,
        workflow: isSettled ? settleClaudeWorkflow(workflow, status) : workflow,
        usage: {
            ...(totalTokens !== undefined && { totalTokens }),
            ...(toolUses !== undefined && { toolUses }),
            ...(durationMs !== undefined && { durationMs }),
        },
    };
}
