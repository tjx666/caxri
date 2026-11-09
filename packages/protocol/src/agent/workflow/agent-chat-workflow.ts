import type { AgentChatTask } from '../agent-chat-contract.js';
import type { AgentChatTaskSnapshot } from '../agent-chat-task-contract.js';
import type { AgentChatWorkflow, AgentChatWorkflowMember } from './agent-chat-workflow-contract.js';

/**
 * Presentation rules for a workflow run (`AgentChatTask.workflow`) that every Client shares: how its members are
 * counted, grouped by phase, and keyed for their own tab.
 */

const MEMBER_TASK_ID = /^workflow:([\w-]{1,100}):([\w-]{1,80})$/u;

const ID_PART = /^[\w-]{1,100}$/u;

/**
 * The task id a workflow member's own conversation is read under: `workflow:<run id>:<agent id>`. Both parts are
 * restricted to word characters and dashes, so Server Core can join them into a transcript path after
 * {@link parseAgentChatWorkflowMemberTaskId}. Undefined when either part does not fit.
 */
export function agentChatWorkflowMemberTaskId(
    runId: string | undefined,
    agentId: string | undefined,
): string | undefined {
    if (!runId || !agentId || !ID_PART.test(runId) || !ID_PART.test(agentId) || agentId.length > 80)
        return undefined;
    return `workflow:${runId}:${agentId}`;
}

export function parseAgentChatWorkflowMemberTaskId(
    taskId: string,
): { runId: string; agentId: string } | undefined {
    const match = MEMBER_TASK_ID.exec(taskId);
    return match?.[1] && match[2] ? { runId: match[1], agentId: match[2] } : undefined;
}

/**
 * The workflow a task tab shows: the live one the Chat lists, else the one rebuilt from the provider's run record. The
 * live run learns its result and script error only from that record, so those come from the record when the live one
 * lacks them.
 */
export function agentChatTaskWorkflow(
    task: Pick<AgentChatTask, 'workflow'> | undefined,
    snapshot: Pick<AgentChatTaskSnapshot, 'workflow'> | undefined,
): AgentChatWorkflow | undefined {
    const live = task?.workflow;
    const recorded = snapshot?.workflow;
    if (!live) return recorded;
    const result = live.result ?? recorded?.result;
    const error = live.error ?? recorded?.error;
    return {
        ...live,
        ...(result !== undefined && { result }),
        ...(error !== undefined && { error }),
    };
}

export interface AgentChatWorkflowCounts {
    total: number;
    completed: number;
    failed: number;
    stopped: number;
    running: number;
    queued: number;
}

export function agentChatWorkflowCounts(
    members: ReadonlyArray<Pick<AgentChatWorkflowMember, 'status'>>,
): AgentChatWorkflowCounts {
    const counts: AgentChatWorkflowCounts = {
        total: members.length,
        completed: 0,
        failed: 0,
        stopped: 0,
        running: 0,
        queued: 0,
    };
    for (const member of members) counts[member.status] += 1;
    return counts;
}

/**
 * One phase of a run with the members that ran in it, in the order the script declared the phases. `declared` is false
 * for a group the script never declared (members without a phase, or with one the run record does not list).
 */
export interface AgentChatWorkflowPhaseGroup {
    title: string | undefined;
    detail: string | undefined;
    members: AgentChatWorkflowMember[];
    counts: AgentChatWorkflowCounts;
}

/**
 * The run's members grouped by phase: declared phases first in their order (also those with no member yet), then any
 * phase only a member names, then members without a phase. Members keep the provider's order within a phase.
 */
export function agentChatWorkflowPhaseGroups(
    workflow: Pick<AgentChatWorkflow, 'members' | 'phases'>,
): AgentChatWorkflowPhaseGroup[] {
    const groups = new Map<string | undefined, Omit<AgentChatWorkflowPhaseGroup, 'counts'>>();
    for (const phase of workflow.phases)
        if (!groups.has(phase.title))
            groups.set(phase.title, { title: phase.title, detail: phase.detail, members: [] });
    // The phone's Hermes runtime lacks ES2023 `toSorted`, so a spread copy sorts in place.
    // eslint-disable-next-line unicorn/no-array-sort -- Sorts the fresh copy; see above.
    const members = [...workflow.members].sort((a, b) => a.index - b.index);
    for (const member of members) {
        let group = groups.get(member.phase);
        if (!group) {
            group = { title: member.phase, detail: undefined, members: [] };
            groups.set(member.phase, group);
        }
        group.members.push(member);
    }
    const unphased = groups.get(undefined);
    groups.delete(undefined);
    const ordered = [...groups.values(), ...(unphased ? [unphased] : [])];
    return ordered.map((group) => ({ ...group, counts: agentChatWorkflowCounts(group.members) }));
}

/**
 * The phase a running workflow is in: the first one with a running member, else the first with a queued one. The strip
 * shows it with its own count (`Review 2/5`).
 */
export function agentChatWorkflowCurrentPhase(
    workflow: Pick<AgentChatWorkflow, 'members' | 'phases'>,
): AgentChatWorkflowPhaseGroup | undefined {
    const groups = agentChatWorkflowPhaseGroups(workflow);
    return (
        groups.find((group) => group.counts.running > 0) ??
        groups.find((group) => group.counts.queued > 0)
    );
}

/**
 * What a workflow's progress label shows wherever a run is listed (Desktop's strip and timeline row, the phone's
 * Background work rows): the running phase with its own count (`Review 2/5`) while the run works, the whole run's count
 * (`10/11`) otherwise, plus how many members failed or were interrupted, which never hide behind a finished count.
 */
export interface AgentChatWorkflowProgressLabel {
    /**
     * The phase title, or undefined for the whole run's count.
     */
    phase: string | undefined;
    done: number;
    total: number;
    failed: number;
    stopped: number;
}

export function agentChatWorkflowProgressLabel(
    workflow: Pick<AgentChatWorkflow, 'members' | 'phases'>,
    isRunning: boolean,
): AgentChatWorkflowProgressLabel | undefined {
    const counts = agentChatWorkflowCounts(workflow.members);
    if (counts.total === 0) return undefined;
    const phase = isRunning ? agentChatWorkflowCurrentPhase(workflow) : undefined;
    const scope = phase && workflow.phases.length > 1 ? phase.counts : counts;
    return {
        phase: phase && workflow.phases.length > 1 ? phase.title : undefined,
        done: scope.completed + scope.failed + scope.stopped,
        total: scope.total,
        failed: counts.failed,
        stopped: counts.stopped,
    };
}

/**
 * Agent types Claude Code ships, which a member row marks apart from a custom agent's name. `workflow-subagent` is the
 * type Claude Code records for an ordinary workflow member.
 */
const ORDINARY_AGENT_TYPES = new Set(['general-purpose', 'workflow-subagent']);

const BUILT_IN_AGENT_TYPES = new Set([
    'Explore',
    'Plan',
    'statusline-setup',
    'claude-code-guide',
    'output-style-setup',
]);

/**
 * What kind of agent ran a member, for its glyph: an ordinary subagent, a built-in exploring or planning agent, another
 * built-in, or a custom agent the user defined.
 */
export type AgentChatWorkflowAgentKind = 'ordinary' | 'explore' | 'plan' | 'builtIn' | 'custom';

export function agentChatWorkflowAgentKind(
    agentType: string | undefined,
): AgentChatWorkflowAgentKind {
    if (!agentType || ORDINARY_AGENT_TYPES.has(agentType)) return 'ordinary';
    if (agentType === 'Explore') return 'explore';
    if (agentType === 'Plan') return 'plan';
    return BUILT_IN_AGENT_TYPES.has(agentType) ? 'builtIn' : 'custom';
}

/**
 * The member a workflow tab shows next to `taskId` in the run's order, for its previous and next buttons. Only members
 * that can be opened count.
 */
export function agentChatWorkflowSibling(
    workflow: Pick<AgentChatWorkflow, 'members' | 'phases'>,
    taskId: string,
    step: -1 | 1,
): AgentChatWorkflowMember | undefined {
    const openable = agentChatWorkflowPhaseGroups(workflow)
        .flatMap((group) => group.members)
        .filter((member) => member.taskId !== undefined);
    const index = openable.findIndex((member) => member.taskId === taskId);
    return index === -1 ? undefined : openable[index + step];
}

/**
 * Whether a task ended in failure for the places that keep failures in view (the Background work strip): a failed task,
 * or a workflow run that finished with a member that failed, which Claude Code still reports as completed.
 */
export function hasAgentChatTaskFailed(task: Pick<AgentChatTask, 'status' | 'workflow'>): boolean {
    if (task.status === 'failed') return true;
    return (
        task.status === 'completed' &&
        task.workflow?.members.some((member) => member.status === 'failed') === true
    );
}
