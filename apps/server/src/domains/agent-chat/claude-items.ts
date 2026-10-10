import type {
    AgentChatDecision,
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatPlan,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentChatTurn,
} from '@caxri/protocol';
import {
    MAX_AGENT_CHAT_DIFF_LENGTH,
    MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL,
    MAX_AGENT_CHAT_FILE_CHANGES,
    MAX_AGENT_CHAT_PLAN_STEPS,
    MAX_AGENT_CHAT_QUESTIONS,
    MAX_AGENT_CHAT_TEXT_LENGTH,
} from '@caxri/protocol';

import { clip, closeDanglingItem, isRecord, stringField } from './chat-items';

/**
 * Pure translation from Claude Code's message stream (Agent SDK messages and the session JSONL transcript share the
 * Anthropic Messages content-block shape) into the provider-neutral Agent Chat projection. Inputs are untrusted JSON.
 *
 * @see https://code.claude.com/docs/en/agent-sdk/typescript
 */

type Json = Record<string, unknown>;

export function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown, limit: number): string | undefined {
    return typeof value === 'string' && value ? clip(value, limit) : undefined;
}

/**
 * Tools whose input names a file they rewrite; their item is a file change rather than a generic tool row.
 */
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);

/**
 * Input fields that name what a tool acts on, in precedence order, for a tool row's one-line summary.
 */
const TOOL_SUBJECT_FIELDS = [
    'command',
    'file_path',
    'notebook_path',
    'path',
    'pattern',
    'url',
    'query',
    'description',
    'skill',
    'prompt',
    'plan',
] as const;

/**
 * Tools the Chat renders elsewhere: the plan card (`TodoWrite`) and the question card (`AskUserQuestion`).
 */
function isClaudeHiddenTool(name: string): boolean {
    return name === 'TodoWrite' || name === 'AskUserQuestion';
}

function claudeToolSummary(input: unknown): string | undefined {
    if (!isRecord(input)) return undefined;
    const field = TOOL_SUBJECT_FIELDS.find((key) => typeof input[key] === 'string' && input[key]);
    if (field) return clip(text(input[field]), 1_000);
    try {
        const serialized = JSON.stringify(input);
        return serialized && serialized !== '{}' ? clip(serialized, 1_000) : undefined;
    } catch {
        return undefined;
    }
}

function lines(value: string, prefix: '+' | '-'): string[] {
    if (!value) return [];
    return value
        .replace(/\n$/u, '')
        .split('\n')
        .map((line) => `${prefix}${line}`);
}

/**
 * A unified-diff-style body for one replacement, used until the tool result supplies the real patch with line numbers.
 */
function replacementDiff(oldText: string, newText: string): string {
    return ['@@', ...lines(oldText, '-'), ...lines(newText, '+')].join('\n');
}

/**
 * Claude Code's `structuredPatch` result: hunks with line numbers, in the shape the `diff` package produces.
 */
export function structuredPatchDiff(patch: unknown): string | undefined {
    if (!Array.isArray(patch) || patch.length === 0) return undefined;
    const hunks = patch.flatMap((hunk) => {
        if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return [];
        const header = `@@ -${Number(hunk.oldStart) || 0},${Number(hunk.oldLines) || 0} +${Number(hunk.newStart) || 0},${Number(hunk.newLines) || 0} @@`;
        return [header, ...hunk.lines.filter((line): line is string => typeof line === 'string')];
    });
    return hunks.length > 0 ? hunks.join('\n') : undefined;
}

function fileChangeDiff(name: string, input: Json): string {
    switch (name) {
        case 'Edit': {
            return replacementDiff(text(input.old_string), text(input.new_string));
        }
        case 'MultiEdit': {
            const edits = Array.isArray(input.edits) ? input.edits : [];
            return edits
                .flatMap((edit) =>
                    isRecord(edit)
                        ? [replacementDiff(text(edit.old_string), text(edit.new_string))]
                        : [],
                )
                .join('\n');
        }
        case 'Write': {
            return ['@@', ...lines(text(input.content), '+')].join('\n');
        }
        default: {
            return replacementDiff('', text(input.new_source));
        }
    }
}

function filePath(input: Json): string {
    return text(input.file_path) || text(input.notebook_path);
}

/**
 * Maps one `tool_use` content block. Returns `undefined` for tools rendered outside the timeline.
 */
export function mapClaudeToolUse(
    block: Json,
    turnId: string | undefined,
): AgentChatItem | undefined {
    const id = stringField(block.id);
    const name = text(block.name);
    if (!id || !name || isClaudeHiddenTool(name)) return undefined;
    const input = isRecord(block.input) ? block.input : {};
    const base = { id: clip(id, 200), ...(turnId && { turnId: clip(turnId, 200) }) };
    if (name === 'Bash') {
        const description = optionalText(input.description, 500);
        return {
            ...base,
            type: 'command',
            command: clip(text(input.command), 4_096),
            ...(description && { description }),
            ...(input.run_in_background === true && { background: true }),
            status: 'running',
            output: '',
        };
    }
    if (FILE_TOOLS.has(name))
        return {
            ...base,
            type: 'fileChange',
            status: 'running',
            changes: [
                {
                    path: clip(filePath(input), 4_096),
                    kind: 'update' as const,
                    diff: clip(
                        fileChangeDiff(name, input),
                        Math.min(MAX_AGENT_CHAT_DIFF_LENGTH, MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL),
                    ),
                },
            ].slice(0, MAX_AGENT_CHAT_FILE_CHANGES),
        };
    const summary = claudeToolSummary(input);
    return {
        ...base,
        type: 'toolCall',
        name: clip(name, 200),
        status: 'running',
        ...(summary && { summary }),
    };
}

/**
 * `TodoWrite`: Claude Code's step list for the turn, replacing any earlier plan.
 */
function mapClaudeTodos(input: unknown, turnId: string | undefined): AgentChatPlan | undefined {
    const todos = isRecord(input) && Array.isArray(input.todos) ? input.todos : undefined;
    if (!todos) return undefined;
    return {
        turnId: clip(turnId ?? '', 200),
        steps: todos.slice(0, MAX_AGENT_CHAT_PLAN_STEPS).flatMap((todo) =>
            isRecord(todo) && text(todo.content)
                ? [
                      {
                          step: clip(text(todo.content), 1_000),
                          status:
                              todo.status === 'completed'
                                  ? ('completed' as const)
                                  : todo.status === 'in_progress'
                                    ? ('inProgress' as const)
                                    : ('pending' as const),
                      },
                  ]
                : [],
        ),
    };
}

/**
 * Context used by the latest model request: everything it read plus what it wrote.
 */
export function claudeUsageTokens(usage: unknown): number | undefined {
    if (!isRecord(usage) || typeof usage.input_tokens !== 'number') return undefined;
    const fields = [
        usage.input_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
        usage.output_tokens,
    ];
    return Math.trunc(
        fields.reduce<number>(
            (sum, value) => sum + (typeof value === 'number' && value > 0 ? value : 0),
            0,
        ),
    );
}

/**
 * The largest context window the result's per-model usage reports. A turn may call a smaller model for internal work,
 * so the main model's window is the largest one.
 */
export function claudeContextWindow(modelUsage: unknown): number | undefined {
    if (!isRecord(modelUsage)) return undefined;
    const windows = Object.values(modelUsage).flatMap((usage) =>
        isRecord(usage) && typeof usage.contextWindow === 'number' && usage.contextWindow > 0
            ? [Math.trunc(usage.contextWindow)]
            : [],
    );
    return windows.length > 0 ? Math.max(...windows) : undefined;
}

/**
 * `AskUserQuestion` input as a question request. Claude Code keys answers by question text, so the request's question
 * ids are positional and {@link claudeQuestionAnswers} maps them back.
 */
export function mapClaudeQuestion(
    id: string,
    input: unknown,
): Extract<AgentChatRequest, { kind: 'question' }> {
    const questions = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
    return {
        id,
        kind: 'question',
        questions: questions.slice(0, MAX_AGENT_CHAT_QUESTIONS).flatMap((question, index) => {
            if (!isRecord(question) || !text(question.question)) return [];
            const options = Array.isArray(question.options) ? question.options : [];
            return [
                {
                    id: `q${index}`,
                    header: clip(text(question.header), 200),
                    question: clip(text(question.question), 2_000),
                    options: options.slice(0, 20).flatMap((option) =>
                        isRecord(option)
                            ? [
                                  {
                                      label: clip(text(option.label), 200),
                                      description: clip(text(option.description), 1_000),
                                  },
                              ]
                            : [],
                    ),
                    // Claude Code always lets the user type their own answer.
                    allowsOther: true,
                },
            ];
        }),
    };
}

/**
 * Converts the Client's positional answers into Claude Code's `answers` map: question text to the chosen labels.
 */
export function claudeQuestionAnswers(
    input: unknown,
    answers: Readonly<Record<string, readonly string[]>>,
): Record<string, string> {
    const questions = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
    return Object.fromEntries(
        questions.slice(0, MAX_AGENT_CHAT_QUESTIONS).flatMap((question, index) => {
            const chosen = Object.hasOwn(answers, `q${index}`) ? answers[`q${index}`] : [];
            return isRecord(question) && text(question.question) && chosen.length > 0
                ? [[text(question.question), chosen.join(', ')]]
                : [];
        }),
    );
}

/**
 * An approval request for a tool Claude Code asks about. `decisions` lists "for this Chat" only when Claude Code offers
 * a session rule to remember the choice.
 */
export function mapClaudeApproval(
    id: string,
    toolName: string,
    input: unknown,
    options: { canRemember: boolean; reason?: string },
): AgentChatRequest {
    const fields = isRecord(input) ? input : {};
    const decisions: AgentChatDecision[] = options.canRemember
        ? ['accept', 'acceptForSession', 'decline']
        : ['accept', 'decline'];
    const reason = optionalText(options.reason, 2_000);
    const base = { id, ...(reason && { reason }), decisions };
    if (toolName === 'Bash') {
        const command = optionalText(fields.command, 4_096);
        const description = optionalText(fields.description, 2_000);
        return {
            ...base,
            ...(!reason && description && { reason: description }),
            kind: 'command',
            ...(command && { command }),
        };
    }
    if (FILE_TOOLS.has(toolName)) return { ...base, kind: 'fileChange', itemId: id };
    const summary =
        toolName === 'ExitPlanMode' ? optionalText(fields.plan, 4_096) : claudeToolSummary(input);
    return { ...base, kind: 'tool', name: clip(toolName, 200), ...(summary && { summary }) };
}

/**
 * Item ids for streamed text and thinking blocks: the model message id plus the block's ordinal among blocks of the
 * same kind. Claude Code streams a block by index and later repeats it in an `assistant` frame of its own, so a
 * per-kind ordinal is the one key both views agree on.
 */
export class ClaudeBlockIds {
    private readonly counters = new Map<string, number>();

    /**
     * Ids handed to blocks that started streaming and have not yet arrived as a complete frame, oldest first.
     */
    private readonly streamed = new Map<string, string[]>();

    private allocate(key: string): string {
        const ordinal = this.counters.get(key) ?? 0;
        this.counters.set(key, ordinal + 1);
        return clip(`${key}:${ordinal}`, 200);
    }

    /**
     * Id for a block that starts streaming; its complete frame later receives the same id from {@link next}.
     */
    open(messageId: string, kind: 'text' | 'thinking'): string {
        const key = `${messageId}:${kind}`;
        const id = this.allocate(key);
        this.streamed.set(key, [...(this.streamed.get(key) ?? []), id]);
        return id;
    }

    /**
     * Id for a complete block: the oldest streamed block of its kind, or a fresh one when it was never streamed.
     */
    next(messageId: string, kind: 'text' | 'thinking'): string {
        const key = `${messageId}:${kind}`;
        return this.streamed.get(key)?.shift() ?? this.allocate(key);
    }

    clear(): void {
        this.counters.clear();
        this.streamed.clear();
    }
}

/**
 * Maps one assistant content block. Tool blocks go through {@link mapClaudeToolUse}; a `TodoWrite` block becomes a plan.
 */
function assistantBlock(
    block: Json,
    messageId: string,
    turnId: string | undefined,
    ids: ClaudeBlockIds,
): { item?: AgentChatItem; plan?: AgentChatPlan } {
    const base = turnId ? { turnId: clip(turnId, 200) } : {};
    switch (block.type) {
        case 'text': {
            return {
                item: {
                    ...base,
                    id: ids.next(messageId, 'text'),
                    type: 'agentMessage',
                    text: clip(text(block.text), MAX_AGENT_CHAT_TEXT_LENGTH),
                    streaming: false,
                },
            };
        }
        case 'thinking': {
            // The ordinal is consumed even for a withheld block, so later blocks keep the ids their stream used.
            const id = ids.next(messageId, 'thinking');
            return text(block.thinking)
                ? {
                      item: {
                          ...base,
                          id,
                          type: 'reasoning',
                          text: clip(text(block.thinking), MAX_AGENT_CHAT_TEXT_LENGTH),
                          streaming: false,
                      },
                  }
                : {};
        }
        case 'tool_use': {
            const item = mapClaudeToolUse(block, turnId);
            const plan =
                block.name === 'TodoWrite' ? mapClaudeTodos(block.input, turnId) : undefined;
            return { ...(item && { item }), ...(plan && { plan }) };
        }
        default: {
            // Redacted thinking, server tool results, and future block types are not conversation content.
            return {};
        }
    }
}

/**
 * Items for one complete assistant message's content blocks, plus the plan its last `TodoWrite` block set.
 */
export function claudeAssistantItems(
    message: Json,
    turnId: string | undefined,
    ids: ClaudeBlockIds,
): { items: AgentChatItem[]; plan?: AgentChatPlan } {
    const messageId = stringField(message.id) ?? 'message';
    const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    const mapped = blocks.map((block) => assistantBlock(block, messageId, turnId, ids));
    const items = mapped.flatMap((entry) => (entry.item ? [entry.item] : []));
    const plan = mapped.findLast((entry) => entry.plan)?.plan;
    return { items, ...(plan && { plan }) };
}

/**
 * Turn state for a finished Claude Code turn, mirroring `finishedTurnOperations` for Codex.
 */
export function finishedClaudeTurn(
    snapshot: AgentChatSnapshot,
    id: string,
    status: AgentChatTurn['status'],
    error: string | undefined,
): { durationMs?: number; operations: AgentChatPatchOperation[] } {
    const operations: AgentChatPatchOperation[] = [];
    for (const item of snapshot.items) {
        if (item.turnId !== id) continue;
        const closed = closeDanglingItem(item);
        if (closed) operations.push({ op: 'upsertItem', item: closed });
    }
    if (status === 'failed' && error)
        operations.push({
            op: 'upsertItem',
            item: {
                id: `${id}:error`,
                turnId: id,
                type: 'notice',
                kind: 'error',
                message: clip(error, 2_000),
            },
        });
    const existing = snapshot.turns.find((turn) => turn.id === id);
    const durationMs =
        existing?.startedAt === undefined
            ? undefined
            : Math.max(0, Date.now() - existing.startedAt);
    operations.push({
        op: 'state',
        state: {
            turns: snapshot.turns.map((turn) =>
                turn.id === id
                    ? { ...turn, status, ...(durationMs !== undefined && { durationMs }) }
                    : turn,
            ),
            requests: [],
            ...(snapshot.activeTurnId === id && { activeTurnId: null }),
        },
    });
    return { ...(durationMs !== undefined && { durationMs }), operations };
}
