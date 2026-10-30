import type {
    AgentChatCommand,
    AgentChatDecision,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatModel,
    AgentChatPlan,
    AgentChatRequest,
    AgentChatSnapshot,
} from '@caxri/protocol';
import {
    MAX_AGENT_CHAT_COMMANDS,
    MAX_AGENT_CHAT_DIFF_LENGTH,
    MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL,
    MAX_AGENT_CHAT_FILE_CHANGES,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_PLAN_STEPS,
} from '@caxri/protocol';

import {
    boundedChatModels,
    clip,
    isRecord,
    replacementDiff,
    stringField,
    tail,
} from '../../chat-items';

/**
 * Pure translation from ACP (Agent Client Protocol) session updates into the provider-neutral Agent Chat projection.
 * Inputs are untrusted JSON. A provider's own naming of tools and its extensions stay in its dialect module
 * (`grok-items.ts`, `antigravity-items.ts`); everything here follows the protocol.
 *
 * @see https://agentclientprotocol.com/protocol/tool-calls
 */

type Json = Record<string, unknown>;

/**
 * One tool call as the updates so far describe it. ACP sends `tool_call` once and then `tool_call_update`s whose
 * present fields replace the earlier values, so the item is always rebuilt from this merged record.
 */
export interface AcpToolCall {
    id: string;
    title: string;
    kind: string;
    status: string;
    rawInput: Json;
    content: unknown[];
    /**
     * The provider's own tool identifier when it sends one beside the protocol fields (Antigravity's `name`).
     */
    toolName?: string;
}

/**
 * How a provider presents its tool calls: the name and subject of a generic tool row, the command of a shell call, and
 * whether a failed call was the user's rejection.
 */
export interface AcpToolPresentation {
    nameAndSubject: (call: AcpToolCall) => { name: string; subject?: string };
    shellCommand: (call: AcpToolCall) => string;
    isRejected: (call: AcpToolCall) => boolean;
}

const TOOL_CALL_ID_LENGTH = 200;

/**
 * Input fields that name what a tool acts on, in precedence order, for a tool row's one-line summary.
 */
const TOOL_SUBJECT_FIELDS = [
    'command',
    'file_path',
    'target_file',
    'target_directory',
    'path',
    'pattern',
    'url',
    'query',
    'description',
] as const;

/**
 * The bounded call id an update names, the key every record and request for the call uses.
 */
export function acpToolCallId(update: Json): string | undefined {
    const id = stringField(update.toolCallId);
    return id ? clip(id, TOOL_CALL_ID_LENGTH) : undefined;
}

/**
 * Merges a `tool_call` or `tool_call_update` into the record for its call. Returns `undefined` for an update without a
 * call id.
 */
export function mergeAcpToolCall(
    previous: AcpToolCall | undefined,
    update: Json,
): AcpToolCall | undefined {
    const id = acpToolCallId(update);
    if (!id) return undefined;
    const toolName = stringField(update.name) ?? previous?.toolName;
    return {
        id,
        title: stringField(update.title) ?? previous?.title ?? '',
        kind: stringField(update.kind) ?? previous?.kind ?? 'other',
        status: stringField(update.status) ?? previous?.status ?? 'pending',
        rawInput: isRecord(update.rawInput) ? update.rawInput : (previous?.rawInput ?? {}),
        content: Array.isArray(update.content) ? update.content : (previous?.content ?? []),
        ...(toolName && { toolName: clip(toolName, 200) }),
    };
}

function itemStatus(status: string): AgentChatItemStatus {
    switch (status) {
        case 'completed': {
            return 'completed';
        }
        case 'failed': {
            return 'failed';
        }
        default: {
            return 'running';
        }
    }
}

/**
 * The text a tool call's `content` carries, joined in order.
 */
export function acpContentText(content: readonly unknown[]): string {
    return content
        .flatMap((entry) =>
            isRecord(entry) &&
            entry.type === 'content' &&
            isRecord(entry.content) &&
            entry.content.type === 'text' &&
            typeof entry.content.text === 'string'
                ? [entry.content.text]
                : [],
        )
        .join('\n');
}

/**
 * The first input field in `fields` that names what a tool acts on, bounded for a one-line summary.
 */
export function acpToolSubject(
    input: Json,
    fields: readonly string[] = TOOL_SUBJECT_FIELDS,
): string | undefined {
    const field = fields.find((key) => typeof input[key] === 'string' && input[key]);
    return field ? clip(String(input[field]), 1_000) : undefined;
}

function diffChanges(
    content: readonly unknown[],
): Extract<AgentChatItem, { type: 'fileChange' }>['changes'] {
    const changes: Extract<AgentChatItem, { type: 'fileChange' }>['changes'] = [];
    let budget = MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL;
    for (const entry of content) {
        if (!isRecord(entry) || entry.type !== 'diff' || typeof entry.path !== 'string') continue;
        if (changes.length >= MAX_AGENT_CHAT_FILE_CHANGES) break;
        const oldText = typeof entry.oldText === 'string' ? entry.oldText : undefined;
        const full = replacementDiff(
            oldText ?? '',
            typeof entry.newText === 'string' ? entry.newText : '',
        );
        const limit = Math.min(MAX_AGENT_CHAT_DIFF_LENGTH, budget);
        const diff = clip(full, limit);
        budget -= diff.length;
        changes.push({
            path: clip(entry.path, 4_096),
            // ACP leaves `oldText` out for a file that did not exist before.
            kind: oldText === undefined ? 'add' : 'update',
            diff,
            ...(diff.length < full.length && { truncated: true }),
        });
    }
    return changes;
}

/**
 * The timeline item for one tool call: a command row for a shell call, a file change once the call carries diffs, and a
 * generic tool row otherwise. `isDeclined` marks a call whose approval the user declined in this live session; a call
 * the provider itself reports as rejected is declined too.
 */
export function mapAcpToolCall(
    call: AcpToolCall,
    turnId: string | undefined,
    isDeclined: boolean,
    presentation: AcpToolPresentation,
): AgentChatItem {
    const base = { id: call.id, ...(turnId && { turnId: clip(turnId, 200) }) };
    const status: AgentChatItemStatus =
        isDeclined || presentation.isRejected(call) ? 'declined' : itemStatus(call.status);
    const output = acpContentText(call.content);
    if (call.kind === 'execute') {
        // The pending call's content is the command's description; output replaces it once the command runs.
        const description = stringField(call.rawInput.description);
        return {
            ...base,
            type: 'command',
            command: clip(presentation.shellCommand(call), 4_096),
            status,
            output: output === description ? '' : tail(output, MAX_AGENT_CHAT_OUTPUT_LENGTH),
        };
    }
    const changes = diffChanges(call.content);
    if (changes.length > 0) return { ...base, type: 'fileChange', status, changes };
    const { name, subject } = presentation.nameAndSubject(call);
    return {
        ...base,
        type: 'toolCall',
        name: clip(name, 200),
        status,
        ...(subject && { summary: subject }),
        ...(output && { output: tail(output, MAX_AGENT_CHAT_OUTPUT_LENGTH) }),
    };
}

/**
 * ACP permission option kinds, mapped to the Chat decision that selects each.
 */
const DECISION_OPTION_KINDS: ReadonlyArray<readonly [AgentChatDecision, readonly string[]]> = [
    ['accept', ['allow_once']],
    ['acceptForSession', ['allow_always']],
    ['decline', ['reject_once', 'reject_always']],
];

function optionKinds(options: unknown): Set<string> {
    if (!Array.isArray(options)) return new Set();
    return new Set(
        options.flatMap((option) =>
            isRecord(option) && typeof option.kind === 'string' ? [option.kind] : [],
        ),
    );
}

/**
 * A `session/request_permission` as an approval card. `call` is the tool call the request gates, already merged with
 * the request's own `toolCall` update; its id keys the request, so a card links to the timeline row it would run.
 */
export function mapAcpPermission(
    call: AcpToolCall,
    options: unknown,
    presentation: AcpToolPresentation,
): AgentChatRequest {
    const kinds = optionKinds(options);
    const decisions = DECISION_OPTION_KINDS.flatMap(([decision, accepted]) =>
        accepted.some((kind) => kinds.has(kind)) ? [decision] : [],
    );
    const base = {
        id: call.id,
        itemId: call.id,
        ...(decisions.length > 0 && { decisions }),
    };
    if (call.kind === 'execute') {
        const reason = stringField(call.rawInput.description);
        return {
            ...base,
            kind: 'command',
            command: clip(presentation.shellCommand(call), 4_096),
            ...(reason && { reason: clip(reason, 2_000) }),
        };
    }
    if (call.kind === 'edit' || diffChanges(call.content).length > 0)
        return { ...base, kind: 'fileChange' };
    const { name, subject } = presentation.nameAndSubject(call);
    return {
        ...base,
        kind: 'tool',
        name: clip(name, 200),
        ...(subject && { summary: subject }),
    };
}

/**
 * The `session/request_permission` result for a Chat decision. A decision the request offered no option for, and an
 * explicit cancel, answer `cancelled`, which ACP defines as the client cancelling the turn.
 */
export function acpPermissionOutcome(options: unknown, decision: AgentChatDecision): Json {
    const accepted = DECISION_OPTION_KINDS.find(([candidate]) => candidate === decision)?.[1] ?? [];
    const list: unknown[] = Array.isArray(options) ? options : [];
    for (const kind of accepted) {
        const option = list.find(
            (candidate) =>
                isRecord(candidate) &&
                candidate.kind === kind &&
                typeof candidate.optionId === 'string',
        );
        if (isRecord(option))
            return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
}

/**
 * A `plan` update: the full step list, replacing any earlier plan.
 */
export function mapAcpPlan(update: Json, turnId: string | undefined): AgentChatPlan {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    return {
        turnId: clip(turnId ?? '', 200),
        steps: entries.slice(0, MAX_AGENT_CHAT_PLAN_STEPS).flatMap((entry) => {
            if (!isRecord(entry) || typeof entry.content !== 'string') return [];
            const status =
                entry.status === 'completed'
                    ? ('completed' as const)
                    : entry.status === 'in_progress'
                      ? ('inProgress' as const)
                      : ('pending' as const);
            return [{ step: clip(entry.content, 1_000), status }];
        }),
    };
}

const COMMAND_NAME = /^[\w:.-]{1,100}$/u;

/**
 * The agent's slash commands, from an `available_commands_update` (or a provider's equivalent in `initialize`). A
 * command runs as prompt text, exactly as typed in the provider's TUI.
 */
export function acpCommands(available: unknown): AgentChatCommand[] {
    if (!Array.isArray(available)) return [];
    const seen = new Set<string>();
    const commands: AgentChatCommand[] = [];
    for (const command of available) {
        if (!isRecord(command)) continue;
        const name = stringField(command.name)?.replace(/^\//u, '');
        if (!name || !COMMAND_NAME.test(name) || seen.has(name)) continue;
        seen.add(name);
        const description = stringField(command.description);
        const hint = isRecord(command.input) ? stringField(command.input.hint) : undefined;
        commands.push({
            name,
            ...(description && { description: clip(description, 500) }),
            ...(hint && { argumentHint: clip(hint, 200) }),
        });
        if (commands.length >= MAX_AGENT_CHAT_COMMANDS) break;
    }
    return commands;
}

export const ACP_PROTOCOL_VERSION = 1;

/**
 * The `initialize` request: Caxri offers no client filesystem or terminal, so the agent uses its own tools.
 */
export function acpInitializeParameters(clientVersion: string): Json {
    return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'caxri', title: 'Caxri', version: clientVersion },
    };
}

/**
 * The value of the `select` config option a session reports for `category` (ACP's `model`, `thought_level`, ...), from
 * a `session/new` or `session/load` result, a `session/set_config_option` result, or a `config_option_update`.
 *
 * @see https://agentclientprotocol.com/protocol/session-config-options
 */
export function acpConfigValue(configOptions: unknown, category: string): string | undefined {
    const options: unknown[] = Array.isArray(configOptions) ? configOptions : [];
    const option = options.find(
        (candidate) =>
            isRecord(candidate) && (candidate.category === category || candidate.id === category),
    );
    const value = isRecord(option) ? stringField(option.currentValue) : undefined;
    return value && /^[\w.-]{1,100}$/u.test(value) ? value : undefined;
}

/**
 * The values a `select` config option offers, each with its display name.
 */
export function acpConfigChoices(
    configOptions: unknown,
    category: string,
): Array<{ value: string; name: string }> {
    const options: unknown[] = Array.isArray(configOptions) ? configOptions : [];
    const option = options.find(
        (candidate) =>
            isRecord(candidate) && (candidate.category === category || candidate.id === category),
    );
    const choices: unknown[] =
        isRecord(option) && Array.isArray(option.options) ? option.options : [];
    return choices.flatMap((choice) => {
        const value = isRecord(choice) ? stringField(choice.value) : undefined;
        if (!value || !/^[\w.-]{1,100}$/u.test(value) || !isRecord(choice)) return [];
        return [{ value, name: clip(stringField(choice.name) ?? value, 200) }];
    });
}

/**
 * The models a `session/new` result's `models` record lists, for the Chat's model picker.
 */
export function acpListedModels(
    models: unknown,
    efforts: (entry: Json) => Pick<AgentChatModel, 'efforts' | 'defaultEffort'> = () => ({
        efforts: [],
    }),
): AgentChatModel[] {
    const available: unknown[] =
        isRecord(models) && Array.isArray(models.availableModels) ? models.availableModels : [];
    return boundedChatModels(
        available.flatMap((entry) => {
            if (!isRecord(entry)) return [];
            const id = stringField(entry.modelId);
            if (!id) return [];
            const description = stringField(entry.description);
            return [
                {
                    id,
                    displayName: stringField(entry.name) ?? id,
                    ...(description && { description }),
                    ...efforts(entry),
                },
            ];
        }),
    );
}

/**
 * Context usage from a `session/prompt` result. `totalTokens` is the conversation's token count after the turn; the
 * cache lifetime is the provider's estimate, since no ACP agent reports one.
 */
export function acpUsage(
    totalTokens: unknown,
    contextWindow: number | undefined,
    cacheTtlMinutes: number,
    respondedAt = Date.now(),
): AgentChatSnapshot['usage'] {
    if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0)
        return undefined;
    return {
        totalTokens: Math.trunc(totalTokens),
        ...(contextWindow !== undefined && { contextWindow }),
        cacheTtlMinutes,
        lastResponseAt: respondedAt,
    };
}
