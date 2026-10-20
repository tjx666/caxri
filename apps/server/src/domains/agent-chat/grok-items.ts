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
    MAX_AGENT_CHAT_QUESTIONS,
} from '@caxri/protocol';

import {
    boundedChatModels,
    clip,
    isRecord,
    replacementDiff,
    stringField,
    tail,
} from './chat-items';

/**
 * Pure translation from Grok Build's ACP (Agent Client Protocol) session updates into the provider-neutral Agent Chat
 * projection. Inputs are untrusted JSON.
 *
 * @see https://agentclientprotocol.com/protocol/tool-calls
 */

type Json = Record<string, unknown>;

/**
 * One tool call as the updates so far describe it. ACP sends `tool_call` once and then `tool_call_update`s whose
 * present fields replace the earlier values, so the item is always rebuilt from this merged record.
 */
export interface GrokToolCall {
    id: string;
    title: string;
    kind: string;
    status: string;
    rawInput: Json;
    content: unknown[];
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
export function grokToolCallId(update: Json): string | undefined {
    const id = stringField(update.toolCallId);
    return id ? clip(id, TOOL_CALL_ID_LENGTH) : undefined;
}

/**
 * Merges a `tool_call` or `tool_call_update` into the record for its call. Returns `undefined` for an update without a
 * call id.
 */
export function mergeGrokToolCall(
    previous: GrokToolCall | undefined,
    update: Json,
): GrokToolCall | undefined {
    const id = grokToolCallId(update);
    if (!id) return undefined;
    return {
        id,
        title: stringField(update.title) ?? previous?.title ?? '',
        kind: stringField(update.kind) ?? previous?.kind ?? 'other',
        status: stringField(update.status) ?? previous?.status ?? 'pending',
        rawInput: isRecord(update.rawInput) ? update.rawInput : (previous?.rawInput ?? {}),
        content: Array.isArray(update.content) ? update.content : (previous?.content ?? []),
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

function contentText(content: readonly unknown[]): string {
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
 * The text Grok Build reports for a tool call the user rejected, e.g. `User rejected the execution for tool
 * `run_terminal_command` `. Grok Build marks such a call `failed`, the same status as a call that broke, both live and
 * in a `session/load` replay; this text is the only trace of the decline once the live session that saw the user's
 * answer is gone. Verified against Grok Build 1.0.50.
 */
const GROK_REJECTED_TEXT = /^User rejected the execution for tool `[^`\n]{1,200}`$/u;

/**
 * Whether Grok Build reported `call` as rejected by the user rather than failed. Without it a Chat rebuilt from a
 * replay after Server Core restarted would show the same declined call as failed.
 */
function isGrokRejected(call: GrokToolCall): boolean {
    return call.status === 'failed' && GROK_REJECTED_TEXT.test(contentText(call.content).trim());
}

function toolSummary(input: Json): string | undefined {
    const field = TOOL_SUBJECT_FIELDS.find((key) => typeof input[key] === 'string' && input[key]);
    return field ? clip(String(input[field]), 1_000) : undefined;
}

/**
 * Grok Build titles a file tool by its action and subject (`Read `/repo/app.ts` `, `List `/repo/src` `), and names it
 * by its own identifier (`read_file`, `list_dir`) when it replays a conversation. Both become the tool names every Chat
 * surface already presents (`Read app.ts`), because a raw title holding a path otherwise reads as an MCP
 * `<server>/<tool>` name. Verified against Grok Build 1.0.62.
 */
const GROK_TOOL_NAMES: Readonly<Record<string, string>> = {
    Read: 'Read',
    read_file: 'Read',
    List: 'LS',
    list_dir: 'LS',
    get_command_or_subagent_output: 'BashOutput',
};

const GROK_TITLE_SUBJECT = /^([A-Z][A-Za-z ]{0,40}) `([^`]+)`$/u;

/**
 * The name and subject a generic tool row shows. A title of the form `Verb `subject` ` splits into the two, even for a
 * verb this table does not know yet, so its subject never lands in the name.
 */
function toolNameAndSubject(call: GrokToolCall): { name: string; subject?: string } {
    const inputSubject = toolSummary(call.rawInput);
    const titled = GROK_TITLE_SUBJECT.exec(call.title);
    if (titled) {
        const [, verb = '', subject = ''] = titled;
        return {
            name: GROK_TOOL_NAMES[verb] ?? verb,
            subject: inputSubject ?? clip(subject, 1_000),
        };
    }
    const title = call.title || call.kind;
    return {
        name: GROK_TOOL_NAMES[title] ?? title,
        ...(inputSubject && { subject: inputSubject }),
    };
}

/**
 * Grok Build titles a shell call `Execute `command` `; the raw input carries the command itself.
 */
function shellCommand(call: GrokToolCall): string {
    const command = stringField(call.rawInput.command);
    if (command) return command;
    return call.title.replace(/^Execute `(.*)`$/su, '$1');
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
 * Grok Build itself reports as rejected is declined too.
 */
export function mapGrokToolCall(
    call: GrokToolCall,
    turnId: string | undefined,
    isDeclined: boolean,
): AgentChatItem {
    const base = { id: call.id, ...(turnId && { turnId: clip(turnId, 200) }) };
    const status: AgentChatItemStatus =
        isDeclined || isGrokRejected(call) ? 'declined' : itemStatus(call.status);
    const output = contentText(call.content);
    if (call.kind === 'execute') {
        // The pending call's content is the command's description; output replaces it once the command runs.
        const description = stringField(call.rawInput.description);
        return {
            ...base,
            type: 'command',
            command: clip(shellCommand(call), 4_096),
            status,
            output: output === description ? '' : tail(output, MAX_AGENT_CHAT_OUTPUT_LENGTH),
        };
    }
    const changes = diffChanges(call.content);
    if (changes.length > 0) return { ...base, type: 'fileChange', status, changes };
    const { name, subject } = toolNameAndSubject(call);
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
export function mapGrokPermission(call: GrokToolCall, options: unknown): AgentChatRequest {
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
            command: clip(shellCommand(call), 4_096),
            ...(reason && { reason: clip(reason, 2_000) }),
        };
    }
    if (call.kind === 'edit' || diffChanges(call.content).length > 0)
        return { ...base, kind: 'fileChange' };
    const { name, subject } = toolNameAndSubject(call);
    return {
        ...base,
        kind: 'tool',
        name: clip(name, 200),
        ...(subject && { summary: subject }),
    };
}

/**
 * The `session/request_permission` result for a Chat decision. A decision the request offered no option for, and an
 * explicit cancel, answer `cancelled`, which Grok Build treats as the user stopping the turn.
 */
export function grokPermissionOutcome(options: unknown, decision: AgentChatDecision): Json {
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
export function mapGrokPlan(update: Json, turnId: string | undefined): AgentChatPlan {
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
 * Grok Build's slash commands, from `initialize`'s `_meta.availableCommands` or an `available_commands_update`. A
 * command runs as prompt text, exactly as typed in the Grok Build TUI.
 */
export function grokCommands(available: unknown): AgentChatCommand[] {
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
 * The `initialize` request: Caxri offers no client filesystem or terminal, so Grok Build uses its own tools.
 */
export function grokInitializeParameters(clientVersion: string): Json {
    return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'caxri', title: 'Caxri', version: clientVersion },
    };
}

/**
 * The context window Grok Build lists for `model`, from a `models` record's `availableModels`.
 */
export function grokContextWindow(models: unknown, model: string): number | undefined {
    const available: unknown[] =
        isRecord(models) && Array.isArray(models.availableModels) ? models.availableModels : [];
    const entry = available.find((candidate) => isRecord(candidate) && candidate.modelId === model);
    const window =
        isRecord(entry) && isRecord(entry._meta) ? entry._meta.totalContextTokens : undefined;
    return typeof window === 'number' && window > 0 ? Math.trunc(window) : undefined;
}

/**
 * The current model and its context window from a `session/new` or `session/load` result's `models`.
 */
export function grokModelState(models: unknown): { model?: string; contextWindow?: number } {
    if (!isRecord(models)) return {};
    const model = stringField(models.currentModelId);
    if (!model) return {};
    const contextWindow = grokContextWindow(models, model);
    return { model: clip(model, 200), ...(contextWindow && { contextWindow }) };
}

/**
 * What the user typed, from a replayed `user_message_chunk` that Grok Build wrapped for the model: an `_x.ai/interject`
 * replays with the wrapper as `text` and the original in `content._meta.displayText`. Absent for an ordinary prompt.
 * Verified on Grok Build 1.0.62 (#1705, #1721).
 */
export function grokDisplayText(content: Json | undefined): string | undefined {
    const meta = content && isRecord(content._meta) ? content._meta : undefined;
    return meta ? stringField(meta.displayText) : undefined;
}

/**
 * The reasoning efforts a model entry lists in `_meta.reasoningEfforts`, lowest first (Grok Build lists the highest
 * first), with the entry's `_meta.reasoningEffort` default when it is one of them. Verified on Grok Build 1.0.62.
 */
function grokEfforts(entry: Json): { efforts: string[]; defaultEffort?: string } {
    const meta = isRecord(entry._meta) ? entry._meta : undefined;
    const listed: unknown[] =
        meta?.supportsReasoningEffort === true && Array.isArray(meta.reasoningEfforts)
            ? meta.reasoningEfforts
            : [];
    const efforts = listed
        .flatMap((effort) => {
            const id = isRecord(effort) ? stringField(effort.id) : undefined;
            return id && /^[\w-]{1,40}$/u.test(id) ? [id] : [];
        })
        .toReversed()
        .slice(0, 10);
    const defaultEffort = stringField(meta?.reasoningEffort);
    return {
        efforts,
        ...(defaultEffort && efforts.includes(defaultEffort) && { defaultEffort }),
    };
}

/**
 * The models a `models` record lists, for the Chat's model picker, each with the reasoning efforts it accepts.
 */
export function grokModels(models: unknown): AgentChatModel[] {
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
                    ...grokEfforts(entry),
                },
            ];
        }),
    );
}

/**
 * The reasoning effort a `configOptions` list (a `session/new` or `session/load` result, a `session/set_config_option`
 * result, or a `config_option_update`) reports as current.
 */
export function grokEffort(configOptions: unknown): string | undefined {
    const options: unknown[] = Array.isArray(configOptions) ? configOptions : [];
    const option = options.find(
        (candidate) => isRecord(candidate) && candidate.id === 'reasoning_effort',
    );
    const value = isRecord(option) ? stringField(option.currentValue) : undefined;
    return value && /^[\w-]{1,40}$/u.test(value) ? value : undefined;
}

/**
 * An `_x.ai/ask_user_question` request as a question request keyed by the tool call that asked it. Grok Build keys
 * answers by question text, so the question ids are positional and {@link grokQuestionAnswers} maps them back.
 */
export function mapGrokQuestion(
    id: string,
    questions: unknown,
): Extract<AgentChatRequest, { kind: 'question' }> {
    const list: unknown[] = Array.isArray(questions) ? questions : [];
    return {
        id,
        kind: 'question',
        questions: list.slice(0, MAX_AGENT_CHAT_QUESTIONS).flatMap((question, index) => {
            const text = isRecord(question) ? stringField(question.question) : undefined;
            if (!text || !isRecord(question)) return [];
            const options: unknown[] = Array.isArray(question.options) ? question.options : [];
            return [
                {
                    id: `q${index}`,
                    header: '',
                    question: clip(text, 2_000),
                    options: options.slice(0, 20).flatMap((option) =>
                        isRecord(option)
                            ? [
                                  {
                                      label: clip(stringField(option.label) ?? '', 200),
                                      description: clip(
                                          stringField(option.description) ?? '',
                                          1_000,
                                      ),
                                  },
                              ]
                            : [],
                    ),
                    // Grok Build accepts any answer text, like its terminal UI's free-form reply.
                    allowsOther: true,
                },
            ];
        }),
    };
}

/**
 * The `_x.ai/ask_user_question` response for the Client's positional answers: answers keyed by question text, a list
 * for a multi-select question and one string otherwise. No answer at all is a cancelled question, so the turn goes on
 * without the user's choice.
 */
export function grokQuestionAnswers(
    questions: unknown,
    answers: Readonly<Record<string, readonly string[]>>,
): Json {
    const list: unknown[] = Array.isArray(questions) ? questions : [];
    const entries = list.slice(0, MAX_AGENT_CHAT_QUESTIONS).flatMap((question, index) => {
        const text = isRecord(question) ? stringField(question.question) : undefined;
        const chosen = Object.hasOwn(answers, `q${index}`) ? answers[`q${index}`] : [];
        if (!text || chosen.length === 0 || !isRecord(question)) return [];
        return [[text, question.multiSelect === true ? [...chosen] : chosen.join(', ')]];
    });
    return entries.length > 0
        ? { outcome: 'accepted', answers: Object.fromEntries(entries) }
        : { outcome: 'cancelled' };
}

/**
 * Context usage from a `session/prompt` result's `_meta.totalTokens`, the conversation's token count after the turn.
 */
export function grokUsage(
    result: unknown,
    contextWindow: number | undefined,
): AgentChatSnapshot['usage'] {
    const meta = isRecord(result) && isRecord(result._meta) ? result._meta : undefined;
    const totalTokens = meta?.totalTokens;
    if (typeof totalTokens !== 'number' || totalTokens < 0) return undefined;
    return {
        totalTokens: Math.trunc(totalTokens),
        ...(contextWindow !== undefined && { contextWindow }),
    };
}
