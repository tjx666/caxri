import type { AgentChatSnapshot } from '../agent/agent-chat-contract.js';

/**
 * Marks where the phone's copy of an item was shortened. Visible in the transcript so a clipped reply never reads as
 * the whole reply.
 */
export const MOBILE_AGENT_CHAT_CLIP_MARKER = '…';

/**
 * The phone shows the follow-up queue as a short read-only list above its composer, so it receives at most this many
 * queued messages, each cut to a one-glance preview. The whole queue (up to `MAX_AGENT_CHAT_QUEUE` messages of
 * `MAX_AGENT_CHAT_QUEUE_TEXT_LENGTH` text) could exceed a frame on its own; these bounds keep it to a few KiB.
 */
export const MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS = 10;
export const MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH = 200;

const previewText = (text: string): string =>
    text.length <= MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH
        ? text
        : `${text.slice(0, MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH)}${MOBILE_AGENT_CHAT_CLIP_MARKER}`;

type AgentChatQueue = NonNullable<AgentChatSnapshot['queue']>;

/**
 * The phone's copy of the follow-up queue: the first queued messages, in send order, each with a text preview and its
 * image count. Deterministic, so the snapshot window and later `state` patches agree.
 */
export function clipAgentChatQueueForMobile(queue: AgentChatQueue): AgentChatQueue {
    return queue.slice(0, MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS).map((message) => ({
        ...message,
        text: previewText(message.text),
        ...(message.command && {
            command: {
                name: message.command.name,
                ...(message.command.arguments !== undefined && {
                    arguments: previewText(message.command.arguments),
                }),
            },
        }),
    }));
}

/**
 * Longest description the phone keeps for a provider command. Its menu row shows one line, and Claude Code lists every
 * installed skill as a command with a description of up to 500 characters, so a full list would crowd the transcript
 * out of the 48 KiB window.
 */
export const MOBILE_AGENT_CHAT_COMMAND_DESCRIPTION_MAX_LENGTH = 120;

/**
 * Longest argument placeholder the phone keeps for a provider command, drawn after the name on the same line.
 */
export const MOBILE_AGENT_CHAT_COMMAND_ARGUMENT_HINT_MAX_LENGTH = 60;

const clipText = (text: string, maxLength: number): string =>
    text.length <= maxLength
        ? text
        : `${text.slice(0, maxLength - MOBILE_AGENT_CHAT_CLIP_MARKER.length)}${MOBILE_AGENT_CHAT_CLIP_MARKER}`;

type AgentChatCommands = NonNullable<AgentChatSnapshot['commands']>;

/**
 * The phone's copy of the provider's commands: every name, so any listed command still runs, with the description and
 * argument placeholder cut to what one menu row shows. Deterministic, so the snapshot window and later `state` patches
 * agree.
 */
export function clipAgentChatCommandsForMobile(commands: AgentChatCommands): AgentChatCommands {
    return commands.map((command) => ({
        name: command.name,
        ...(command.description !== undefined && {
            description: clipText(
                command.description,
                MOBILE_AGENT_CHAT_COMMAND_DESCRIPTION_MAX_LENGTH,
            ),
        }),
        ...(command.argumentHint !== undefined && {
            argumentHint: clipText(
                command.argumentHint,
                MOBILE_AGENT_CHAT_COMMAND_ARGUMENT_HINT_MAX_LENGTH,
            ),
        }),
    }));
}

/**
 * The phone lists background work in a sheet above its composer, so it receives every running task (up to
 * {@link MOBILE_AGENT_CHAT_TASKS_MAX_ITEMS}, the newest started kept) and the
 * {@link MOBILE_AGENT_CHAT_ENDED_TASKS_MAX_ITEMS} that ended most recently, each with its title and command line cut to
 * one glance and its summary to a line or two. Desktop's list (up to `MAX_AGENT_CHAT_TASKS` tasks with 10,000-character
 * commands) could fill a frame on its own; these bounds keep it to a few KiB in practice and under half the window at
 * worst. The full command and the output tail come from `mobile.agentChat.readTask`. A workflow run keeps the outline
 * {@link clipAgentChatWorkflowForMobile} cuts, within {@link MOBILE_AGENT_CHAT_WORKFLOWS_MAX_BYTES} for all runs.
 */
export const MOBILE_AGENT_CHAT_TASKS_MAX_ITEMS = 24;
export const MOBILE_AGENT_CHAT_ENDED_TASKS_MAX_ITEMS = 10;
export const MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH = 300;
export const MOBILE_AGENT_CHAT_TASK_SUMMARY_MAX_LENGTH = 200;

/**
 * Every workflow outline the phone's task list carries together stays under this many bytes (JSON-encoded UTF-8),
 * running runs first, then the most recently ended. Desktop's full runs once filled the 48 KiB window with member
 * previews (up to 200 members of 2,500 characters each), so the phone showed an empty Chat. An outline costs about 100
 * bytes per member, so a typical run of a few dozen members fits several times over; a run too large for what is left
 * falls back to its compact outline (about 50 bytes per member, see {@link compactAgentChatWorkflowOutline}), and one
 * too large even for that reaches the phone as a plain subagent task.
 */
export const MOBILE_AGENT_CHAT_WORKFLOWS_MAX_BYTES = 16 * 1_024;

/**
 * Longest member label, phase title, or agent type the phone's workflow outline keeps: one list row's worth.
 */
export const MOBILE_AGENT_CHAT_WORKFLOW_LABEL_MAX_LENGTH = 80;

/**
 * Longest script error the phone's workflow outline keeps; the detail shows it under the run's status.
 */
export const MOBILE_AGENT_CHAT_WORKFLOW_ERROR_MAX_LENGTH = 300;

/**
 * Longest script result a run's detail (`mobile.agentChat.readTask`) keeps. The task list never carries it.
 */
export const MOBILE_AGENT_CHAT_WORKFLOW_RESULT_MAX_LENGTH = 2_000;

type AgentChatTasks = NonNullable<AgentChatSnapshot['tasks']>;

type AgentChatWorkflowOutline = NonNullable<AgentChatTasks[number]['workflow']>;

const newestFirst =
    (key: 'endedAt' | 'startedAt') =>
    (left: AgentChatTasks[number], right: AgentChatTasks[number]): number =>
        (right[key] ?? 0) - (left[key] ?? 0);

const workflowByteLength = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The outline of a workflow run the phone draws: its phase titles and, for every member, its label, phase, status,
 * agent type, and the task id its conversation opens under, so the phone's counts match Desktop's exactly. Previews,
 * timings, and usage stay on the computer; the script's result is kept only with `withResult`, for the run's own
 * detail. Deterministic, so the snapshot window and later `state` patches agree.
 */
function clipAgentChatWorkflowForMobile(
    workflow: AgentChatWorkflowOutline,
    { withResult = false }: { withResult?: boolean } = {},
): AgentChatWorkflowOutline {
    const label = (text: string): string =>
        clipText(text, MOBILE_AGENT_CHAT_WORKFLOW_LABEL_MAX_LENGTH);
    return {
        ...(workflow.runId !== undefined && { runId: workflow.runId }),
        phases: workflow.phases.map((phase) => ({ title: label(phase.title) })),
        members: workflow.members.map((member) => ({
            index: member.index,
            ...(member.taskId !== undefined && { taskId: member.taskId }),
            label: label(member.label),
            ...(member.phase !== undefined && { phase: label(member.phase) }),
            status: member.status,
            ...(member.agentType !== undefined && { agentType: label(member.agentType) }),
        })),
        ...(withResult &&
            workflow.result !== undefined && {
                result: clipText(workflow.result, MOBILE_AGENT_CHAT_WORKFLOW_RESULT_MAX_LENGTH),
            }),
        ...(workflow.error !== undefined && {
            error: clipText(workflow.error, MOBILE_AGENT_CHAT_WORKFLOW_ERROR_MAX_LENGTH),
        }),
        ...(workflow.isInterrupted !== undefined && { isInterrupted: workflow.isInterrupted }),
    };
}

/**
 * A workflow outline without member labels, agent types, or task ids: still every member's status and phase, so the
 * phone's progress (`Review 2/5`) stays exact for a run with up to 200 members, but its rows read `Subagent 12` and
 * cannot open a member. A finished run's detail reads the full outline through `mobile.agentChat.readTask`.
 */
function compactAgentChatWorkflowOutline(
    outline: AgentChatWorkflowOutline,
): AgentChatWorkflowOutline {
    return {
        ...outline,
        members: outline.members.map((member) => ({
            index: member.index,
            label: '',
            ...(member.phase !== undefined && { phase: member.phase }),
            status: member.status,
        })),
    };
}

/**
 * Longest member label a run's detail keeps when its full outline would not fit
 * {@link MOBILE_AGENT_CHAT_TASK_WORKFLOW_MAX_BYTES}: still enough to tell members apart, and every member keeps its task
 * id, so each one still opens.
 */
const MOBILE_AGENT_CHAT_WORKFLOW_SHORT_LABEL_MAX_LENGTH = 24;

/**
 * Most bytes a run's outline takes in its detail (`mobile.agentChat.readTask`), leaving the rest of the 48 KiB frame to
 * the task's other fields (a run rebuilt from its record has no items). 200 members with 80-character labels, phases,
 * and agent types take about 70 KiB in full and about 40 KiB with short labels, the 2,000-character result included.
 */
export const MOBILE_AGENT_CHAT_TASK_WORKFLOW_MAX_BYTES = 40 * 1_024;

/**
 * A run's outline for its detail: in full when it fits {@link MOBILE_AGENT_CHAT_TASK_WORKFLOW_MAX_BYTES}, else with
 * short labels and phase titles and no agent types (members still open), else compact (exact counts only). The result
 * rides on every tier.
 */
export function fitAgentChatWorkflowDetailForMobile(
    workflow: AgentChatWorkflowOutline,
): AgentChatWorkflowOutline {
    const full = clipAgentChatWorkflowForMobile(workflow, { withResult: true });
    /**
     * Phase titles shorten the same way on the run and on its members, so members still group under their phase.
     */
    const shorten = (text: string): string =>
        clipText(text, MOBILE_AGENT_CHAT_WORKFLOW_SHORT_LABEL_MAX_LENGTH);
    const short: AgentChatWorkflowOutline = {
        ...full,
        phases: full.phases.map((phase) => ({ title: shorten(phase.title) })),
        members: full.members.map((member) => ({
            index: member.index,
            ...(member.taskId !== undefined && { taskId: member.taskId }),
            label: shorten(member.label),
            ...(member.phase !== undefined && { phase: shorten(member.phase) }),
            status: member.status,
        })),
    };
    return (
        [full, short].find(
            (candidate) =>
                workflowByteLength(candidate) <= MOBILE_AGENT_CHAT_TASK_WORKFLOW_MAX_BYTES,
        ) ?? compactAgentChatWorkflowOutline(full)
    );
}

/**
 * The outlines the phone's task list keeps, by task id: running runs newest first, then ended runs most recently ended
 * first, each in full or compact while the total stays within {@link MOBILE_AGENT_CHAT_WORKFLOWS_MAX_BYTES}. A run that
 * fits neither is skipped, never cut, so a kept outline always counts every member.
 */
function keptWorkflowOutlines(tasks: AgentChatTasks): Map<string, AgentChatWorkflowOutline> {
    const ordered = [
        ...tasks.filter((task) => task.status === 'running').sort(newestFirst('startedAt')),
        ...tasks.filter((task) => task.status !== 'running').sort(newestFirst('endedAt')),
    ];
    const kept = new Map<string, AgentChatWorkflowOutline>();
    let remaining = MOBILE_AGENT_CHAT_WORKFLOWS_MAX_BYTES;
    for (const task of ordered) {
        if (!task.workflow) continue;
        const full = clipAgentChatWorkflowForMobile(task.workflow);
        const outline = [full, compactAgentChatWorkflowOutline(full)].find(
            (candidate) => workflowByteLength(candidate) <= remaining,
        );
        if (!outline) continue;
        remaining -= workflowByteLength(outline);
        kept.set(task.id, outline);
    }
    return kept;
}

/**
 * The phone's copy of the Chat's background work, in Desktop's order. Deterministic, so the snapshot window and later
 * `state` patches agree.
 */
export function clipAgentChatTasksForMobile(tasks: AgentChatTasks): AgentChatTasks {
    // `filter` returns fresh copies to sort in place; the phone's Hermes runtime lacks ES2023 `toSorted`.
    const kept = new Set([
        ...tasks
            .filter((task) => task.status === 'running')
            .sort(newestFirst('startedAt'))
            .slice(0, MOBILE_AGENT_CHAT_TASKS_MAX_ITEMS),
        ...tasks
            .filter((task) => task.status !== 'running')
            .sort(newestFirst('endedAt'))
            .slice(0, MOBILE_AGENT_CHAT_ENDED_TASKS_MAX_ITEMS),
    ]);
    const listed = tasks.filter((task) => kept.has(task));
    const outlines = keptWorkflowOutlines(listed);
    return listed.map((task) => {
        const clipped = {
            ...task,
            title: clipText(task.title, MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH),
            ...(task.command !== undefined && {
                command: clipText(task.command, MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH),
            }),
            ...(task.summary !== undefined && {
                summary: clipText(task.summary, MOBILE_AGENT_CHAT_TASK_SUMMARY_MAX_LENGTH),
            }),
        };
        delete clipped.workflow;
        const outline = outlines.get(task.id);
        return outline ? { ...clipped, workflow: outline } : clipped;
    });
}

/**
 * Longest HTTPS icon URL the phone keeps. Longer ones are dropped, because the server list rides in every snapshot and
 * `state` patch and the phone loads each icon by its URL.
 */
const MOBILE_AGENT_CHAT_MCP_ICON_URL_MAX_LENGTH = 512;

type AgentChatMcpServers = NonNullable<AgentChatSnapshot['mcpServers']>;

/**
 * The phone's copy of the MCP servers a Chat's tool calls named: each server's name, title, site origins, and HTTPS
 * icon URLs. Inline (`data:`) icons stay on the computer, because an inline image would spend the phone's frame budget;
 * the phone loads the HTTPS icons itself and draws the connector glyph while one loads or when none does.
 * Deterministic, so the snapshot window and later `state` patches agree.
 */
export function clipAgentChatMcpServersForMobile(
    servers: AgentChatMcpServers,
): AgentChatMcpServers {
    return servers.map((server) => {
        const icons = (server.icons ?? []).filter(
            ({ src }) =>
                src.startsWith('https://') &&
                src.length <= MOBILE_AGENT_CHAT_MCP_ICON_URL_MAX_LENGTH,
        );
        return {
            name: server.name,
            ...(server.title !== undefined && { title: server.title }),
            ...(icons.length > 0 && { icons }),
            ...(server.siteOrigins && { siteOrigins: server.siteOrigins }),
        };
    });
}

/**
 * Bounded copies of Desktop's Chat state for the phone: the background work (see {@link clipAgentChatTasksForMobile}),
 * the follow-up queue as a bounded preview (see {@link clipAgentChatQueueForMobile}) with its paused flag and its real
 * length, which the preview alone cannot tell once the queue outgrows it, the provider's commands shortened (see
 * {@link clipAgentChatCommandsForMobile}), and the MCP servers without their inline icons (see
 * {@link clipAgentChatMcpServersForMobile}).
 */
export function clipAgentChatStateForMobile<
    State extends Pick<
        Partial<AgentChatSnapshot>,
        'commands' | 'mcpServers' | 'queue' | 'queueLength' | 'tasks'
    >,
>(state: State): State {
    if (!state.tasks && !state.queue && !state.commands && !state.mcpServers) return state;
    const rest = { ...state };
    if (rest.mcpServers) rest.mcpServers = clipAgentChatMcpServersForMobile(rest.mcpServers);
    if (rest.commands) rest.commands = clipAgentChatCommandsForMobile(rest.commands);
    if (rest.tasks) rest.tasks = clipAgentChatTasksForMobile(rest.tasks);
    if (rest.queue) {
        rest.queueLength = rest.queue.length;
        rest.queue = clipAgentChatQueueForMobile(rest.queue);
    }
    return rest;
}
