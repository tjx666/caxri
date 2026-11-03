import type { AgentChatWorkflow } from '@caxri/protocol';

import { clip, isRecord } from '../../../chat-items';
import type { ChatTaskList } from '../../../tasks/task-list';
import { text } from '../items';
import {
    claudeWorkflowRunIdFromText,
    mergeClaudeWorkflow,
    parseClaudeWorkflowProgress,
} from './record';

type Json = Record<string, unknown>;

/**
 * Follows the `Workflow` runs of one Claude Code Chat for `ClaudeTasks`: the run id each `Workflow` tool result names
 * (which keys the members' transcripts, and can arrive before or after the run's `task_started`), and the phases and
 * members its `task_progress` frames report. A workflow task is keyed by its `Workflow` tool call id.
 */
export class ClaudeWorkflowRuns {
    /**
     * `Workflow` tool call id to the run id its result named; empty until the result arrives.
     */
    private readonly runs = new Map<string, string>();

    constructor(private readonly list: ChatTaskList) {}

    noteToolUse(toolUseId: string, name: string): void {
        if (name === 'Workflow') this.runs.set(clip(toolUseId, 200), '');
    }

    /**
     * The workflow a starting run's task carries: what it already had, with the run id once known.
     */
    started(
        existing: AgentChatWorkflow | undefined,
        toolUseId: string | undefined,
    ): AgentChatWorkflow {
        const runId = toolUseId ? this.runs.get(clip(toolUseId, 200)) : undefined;
        return mergeClaudeWorkflow(existing, { phases: [], members: [], ...(runId && { runId }) });
    }

    /**
     * The task's workflow with a `workflow_progress` report folded in; undefined for any other task.
     */
    progress(taskId: string, entries: unknown): AgentChatWorkflow | undefined {
        const previous = this.list.get(taskId)?.workflow;
        if (!previous || !Array.isArray(entries)) return undefined;
        return mergeClaudeWorkflow(previous, parseClaudeWorkflowProgress(entries, previous.runId));
    }

    /**
     * Records the run id a `Workflow` tool result names, so the run's members can be opened. Only results of `Workflow`
     * calls count: another tool's output can mention a workflow folder too.
     */
    noteResult(toolUseId: string, block: Json): void {
        if (this.runs.get(toolUseId) !== '') return;
        const content = Array.isArray(block.content)
            ? block.content
                  .filter(isRecord)
                  .map((part) => text(part.text))
                  .join('\n')
            : text(block.content);
        const runId = claudeWorkflowRunIdFromText(content);
        if (!runId) return;
        this.runs.set(toolUseId, runId);
        const workflow = this.list.get(toolUseId)?.workflow;
        if (workflow && !workflow.runId)
            this.list.upsert(toolUseId, { workflow: { ...workflow, runId } });
    }
}
