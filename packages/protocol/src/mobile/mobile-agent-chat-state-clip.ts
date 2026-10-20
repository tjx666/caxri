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
 * worst. The full command and the output tail come from `mobile.agentChat.readTask`.
 */
export const MOBILE_AGENT_CHAT_TASKS_MAX_ITEMS = 24;
export const MOBILE_AGENT_CHAT_ENDED_TASKS_MAX_ITEMS = 10;
export const MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH = 300;
export const MOBILE_AGENT_CHAT_TASK_SUMMARY_MAX_LENGTH = 200;

type AgentChatTasks = NonNullable<AgentChatSnapshot['tasks']>;

const newestFirst =
    (key: 'endedAt' | 'startedAt') =>
    (left: AgentChatTasks[number], right: AgentChatTasks[number]): number =>
        (right[key] ?? 0) - (left[key] ?? 0);

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
    return tasks
        .filter((task) => kept.has(task))
        .map((task) => ({
            ...task,
            title: clipText(task.title, MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH),
            ...(task.command !== undefined && {
                command: clipText(task.command, MOBILE_AGENT_CHAT_TASK_TITLE_MAX_LENGTH),
            }),
            ...(task.summary !== undefined && {
                summary: clipText(task.summary, MOBILE_AGENT_CHAT_TASK_SUMMARY_MAX_LENGTH),
            }),
        }));
}

/**
 * Longest HTTPS icon URL the phone keeps. Longer ones are dropped, because the server list rides in every snapshot and
 * `state` patch and the phone loads each icon by its URL.
 */
export const MOBILE_AGENT_CHAT_MCP_ICON_URL_MAX_LENGTH = 512;

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
