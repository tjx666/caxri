import type {
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatPlan,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentChatUsageLimit,
} from '@caxri/protocol';
import {
    MAX_AGENT_CHAT_DIFF_LENGTH,
    MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL,
    MAX_AGENT_CHAT_FILE_CHANGES,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_PLAN_STEPS,
    MAX_AGENT_CHAT_QUESTIONS,
    MAX_AGENT_CHAT_TEXT_LENGTH,
} from '@caxri/protocol';

import {
    codexAmendmentPrefix,
    codexApprovalDecisions,
    codexExecpolicyAmendment,
} from './approval/codex-decisions';
import { clip, isRecord, readableToolInputSummary, tail } from './chat-items';
import { withCacheRewriteEstimate } from './chat-usage';
import type { CodexComputerUseBindings } from './codex-computer-use';
import { codexComputerUseCall } from './codex-computer-use';
import { codexDelivery, codexUserImageCount, isCodexNotice, userMessageText } from './codex-input';

/**
 * Pure translation from Codex app-server v2 `ThreadItem`s and server requests into the provider-neutral Agent Chat
 * projection. Inputs are untrusted JSON, so every field is read defensively and every string is bounded.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs
 */

type Json = Record<string, unknown>;
type RetryCause = NonNullable<Extract<AgentChatItem, { type: 'notice' }>['retry']>['cause'];

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown, limit: number): string | undefined {
    return typeof value === 'string' && value ? clip(value, limit) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function duration(value: unknown): number | undefined {
    const ms = optionalNumber(value);
    return ms !== undefined && ms >= 0 ? ms : undefined;
}

/**
 * Codex statuses are `inProgress | completed | failed | declined`; MCP adds nothing new. Unknown values stay running
 * until the turn boundary closes them.
 */
function itemStatus(value: unknown): AgentChatItemStatus {
    switch (value) {
        case 'completed': {
            return 'completed';
        }
        case 'failed': {
            return 'failed';
        }
        case 'declined': {
            return 'declined';
        }
        default: {
            return 'running';
        }
    }
}

function summarizeJson(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        return serialized ? clip(serialized, 1_000) : undefined;
    } catch {
        return undefined;
    }
}

function mcpOutput(item: Json): string | undefined {
    if (isRecord(item.error)) return optionalText(item.error.message, MAX_AGENT_CHAT_OUTPUT_LENGTH);
    if (!isRecord(item.result) || !Array.isArray(item.result.content)) return undefined;
    const parts = item.result.content.flatMap((part) =>
        isRecord(part) && typeof part.text === 'string' ? [part.text] : [],
    );
    return parts.length > 0 ? tail(parts.join('\n'), MAX_AGENT_CHAT_OUTPUT_LENGTH) : undefined;
}

/**
 * Collab tool statuses are `inProgress | completed | failed | interrupted`.
 */
function collabStatus(value: unknown): AgentChatItemStatus {
    return value === 'interrupted' ? 'interrupted' : itemStatus(value);
}

/**
 * Multi-agent v2 reports a subagent interaction as a `subAgentActivity` item instead of a collab tool call; its kind
 * names the matching tool.
 */
const SUB_AGENT_ACTIVITY_NAMES: Partial<Record<string, string>> = {
    started: 'spawnAgent',
    interacted: 'sendMessage',
    interrupted: 'interruptAgent',
    completed: 'agentCompleted',
};

/**
 * The display name of a multi-agent v2 `agentPath`. Codex addresses each subagent by its position in the agent tree
 * (`/root/reviewer`, or `/root/planner/reviewer` for a grandchild), and only the last segment is the name the model
 * gave it; the `/root/` prefix is the same on every subagent and only pushed the name out of a narrow sidebar row.
 */
export function codexAgentName(agentPath: unknown, limit: number): string | undefined {
    if (typeof agentPath !== 'string') return undefined;
    const name = agentPath
        .split('/')
        .findLast((segment) => segment.trim())
        ?.trim();
    return name ? clip(name, limit) : undefined;
}

/**
 * A subagent tool call (`spawnAgent`, `sendInput`, `wait`, `closeAgent`, ...). The summary is the prompt it sent, else
 * the names of the agents it addressed (a `wait` says whom it waits for), else how many; the output is the final
 * messages the target agents reported, such as a `wait` result.
 */
function mapCollabAgentToolCall(
    raw: Json,
    base: { id: string; turnId?: string },
    agentName?: (threadId: string) => string | undefined,
): AgentChatItem {
    const receivers = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds : [];
    const names = receivers.map((id) => (typeof id === 'string' ? agentName?.(id) : undefined));
    const summary =
        optionalText(raw.prompt, 1_000) ??
        (names.length > 0 && names.every(Boolean) ? clip(names.join(', '), 1_000) : undefined) ??
        (receivers.length > 0
            ? `${receivers.length} agent${receivers.length === 1 ? '' : 's'}`
            : undefined);
    const states = isRecord(raw.agentsStates) ? Object.values(raw.agentsStates) : [];
    const messages = states.flatMap((state) =>
        isRecord(state) && typeof state.message === 'string' && state.message
            ? [state.message]
            : [],
    );
    const output =
        messages.length > 0 ? tail(messages.join('\n\n'), MAX_AGENT_CHAT_OUTPUT_LENGTH) : undefined;
    return {
        ...base,
        type: 'toolCall',
        name: clip(text(raw.tool) || 'agent', 200),
        status: collabStatus(raw.status),
        ...(summary && { summary }),
        ...(output && { output }),
    };
}

/**
 * Maps one `ThreadItem`. Returns `undefined` for item kinds the Chat does not render (plans arrive through
 * `turn/plan/updated`; review markers and hook prompts are not conversation content). `computerUse` is the live Chat's
 * memory of Computer Use variables, which names a running step's surface before its result arrives.
 */
export function mapCodexItem(
    raw: unknown,
    turnId: string | undefined,
    isStreaming: boolean,
    computerUse?: CodexComputerUseBindings,
    agentName?: (threadId: string) => string | undefined,
): AgentChatItem | undefined {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return undefined;
    const base = { id: clip(raw.id, 200), ...(turnId && { turnId: clip(turnId, 200) }) };
    switch (raw.type) {
        case 'userMessage': {
            if (isCodexNotice(raw))
                return {
                    ...base,
                    type: 'notice',
                    kind: 'output',
                    heading: { kind: 'event', event: 'caxriNote' },
                    message: clip(userMessageText(raw.content), 2_000),
                };
            // A turn started with no input (the automatic continuation after a usage limit resets) has no message.
            if (Array.isArray(raw.content) && raw.content.length === 0) return undefined;
            const imageCount = Math.min(codexUserImageCount(raw.content), MAX_AGENT_CHAT_IMAGES);
            const delivery = codexDelivery(raw);
            return {
                ...base,
                type: 'userMessage',
                text: clip(userMessageText(raw.content), MAX_AGENT_CHAT_TEXT_LENGTH),
                ...(imageCount > 0 && { images: Array.from({ length: imageCount }, () => ({})) }),
                ...(delivery && { delivery }),
            };
        }
        /**
         * A plan-mode plan reads as a reply marked `proposedPlan`; its deltas are opted out, so its text arrives whole.
         */
        case 'plan':
        case 'agentMessage': {
            return {
                ...base,
                type: 'agentMessage',
                text: clip(text(raw.text), MAX_AGENT_CHAT_TEXT_LENGTH),
                streaming: isStreaming,
                ...(raw.type === 'plan' && { proposedPlan: true as const }),
            };
        }
        case 'reasoning': {
            const summary = Array.isArray(raw.summary) ? raw.summary.map(text) : [];
            return {
                ...base,
                type: 'reasoning',
                text: clip(summary.join('\n\n'), MAX_AGENT_CHAT_TEXT_LENGTH),
                streaming: isStreaming,
            };
        }
        case 'commandExecution': {
            return {
                ...base,
                type: 'command',
                command: clip(text(raw.command), 4_096),
                status: itemStatus(raw.status),
                output: tail(text(raw.aggregatedOutput), MAX_AGENT_CHAT_OUTPUT_LENGTH),
                ...(optionalNumber(raw.exitCode) !== undefined && {
                    exitCode: Math.trunc(raw.exitCode as number),
                }),
                ...(duration(raw.durationMs) !== undefined && {
                    durationMs: duration(raw.durationMs),
                }),
            };
        }
        case 'fileChange': {
            const changes = Array.isArray(raw.changes) ? raw.changes : [];
            /**
             * One item may carry many diffs; their sum is bounded too, so a single large patch cannot outgrow the whole
             * projection's text budget (which always keeps the newest item).
             */
            let remaining = MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL;
            return {
                ...base,
                type: 'fileChange',
                status: itemStatus(raw.status),
                changes: changes.slice(0, MAX_AGENT_CHAT_FILE_CHANGES).flatMap((change) => {
                    if (!isRecord(change)) return [];
                    const kind = isRecord(change.kind) ? change.kind.type : undefined;
                    const fullDiff = text(change.diff);
                    const diff = clip(fullDiff, Math.min(MAX_AGENT_CHAT_DIFF_LENGTH, remaining));
                    remaining -= diff.length;
                    return [
                        {
                            path: clip(text(change.path), 4_096),
                            kind: kind === 'add' || kind === 'delete' ? kind : 'update',
                            diff,
                            ...(diff.length < fullDiff.length && { truncated: true }),
                        },
                    ];
                }),
            };
        }
        case 'mcpToolCall': {
            const step = codexComputerUseCall(raw, computerUse);
            if (step)
                return {
                    ...base,
                    type: 'toolCall',
                    ...step,
                    status: itemStatus(raw.status),
                    ...(duration(raw.durationMs) !== undefined && {
                        durationMs: duration(raw.durationMs),
                    }),
                };
            const output = mcpOutput(raw);
            const summary = summarizeJson(raw.arguments);
            return {
                ...base,
                type: 'toolCall',
                name: clip(`${text(raw.server)}/${text(raw.tool)}`, 200),
                status: itemStatus(raw.status),
                ...(summary && { summary }),
                ...(output && { output }),
                ...(duration(raw.durationMs) !== undefined && {
                    durationMs: duration(raw.durationMs),
                }),
            };
        }
        case 'dynamicToolCall': {
            // Unlike MCP arguments, which tracker detection parses, a dynamic tool's arguments only title its row, so
            // the title is a readable digest and the JSON stays in `input` for the expanded row.
            const arguments_ = raw.arguments;
            const summary = isRecord(arguments_)
                ? readableToolInputSummary(arguments_, 1_000)
                : summarizeJson(arguments_);
            const input = isRecord(arguments_) ? summarizeJson(arguments_) : undefined;
            return {
                ...base,
                type: 'toolCall',
                name: clip(text(raw.tool) || 'tool', 200),
                status: itemStatus(raw.status),
                ...(summary && { summary }),
                ...(input && input !== '{}' && { input }),
                ...(duration(raw.durationMs) !== undefined && {
                    durationMs: duration(raw.durationMs),
                }),
            };
        }
        case 'webSearch': {
            const summary = optionalText(raw.query, 1_000);
            return {
                ...base,
                type: 'toolCall',
                name: 'webSearch',
                status: isStreaming ? 'running' : 'completed',
                ...(summary && { summary }),
            };
        }
        case 'contextCompaction': {
            /**
             * The notice says the context was compacted, so it appears only once compaction completed; while it runs
             * the snapshot's `operation` says so instead.
             */
            return isStreaming ? undefined : { ...base, type: 'notice', kind: 'compacted' };
        }
        case 'collabAgentToolCall': {
            return mapCollabAgentToolCall(raw, base, agentName);
        }
        case 'subAgentActivity': {
            const name = SUB_AGENT_ACTIVITY_NAMES[text(raw.kind)];
            if (!name) return undefined;
            const summary = codexAgentName(raw.agentPath, 1_000);
            return {
                ...base,
                type: 'toolCall',
                name,
                status: 'completed',
                ...(summary && { summary }),
            };
        }
        default: {
            return undefined;
        }
    }
}

/**
 * Stable request key: an approval callback id when Codex supplies one (several callbacks can share one item), else the
 * item id. Codex re-sends pending requests with fresh transport ids after a resume, so the transport id is not stable.
 */
export function codexRequestKey(parameters: Json): string | undefined {
    const key = text(parameters.approvalId) || text(parameters.itemId);
    return key ? clip(key, 200) : undefined;
}

export type CodexRequestKind = 'command' | 'fileChange' | 'question';

export function codexRequestKind(method: string): CodexRequestKind | undefined {
    switch (method) {
        case 'item/commandExecution/requestApproval': {
            return 'command';
        }
        case 'item/fileChange/requestApproval': {
            return 'fileChange';
        }
        case 'item/tool/requestUserInput': {
            return 'question';
        }
        default: {
            return undefined;
        }
    }
}

function approvalFields(id: string, parameters: Json) {
    const itemId = optionalText(parameters.itemId, 200);
    const reason = optionalText(parameters.reason, 2_000);
    const decisions = codexApprovalDecisions(parameters);
    return {
        id,
        ...(itemId && { itemId }),
        ...(reason && { reason }),
        ...(decisions && { decisions }),
    };
}

export function mapCodexRequest(
    kind: CodexRequestKind,
    id: string,
    parameters: Json,
): AgentChatRequest {
    switch (kind) {
        case 'command': {
            const command = optionalText(parameters.command, 4_096);
            const cwd = optionalText(parameters.cwd, 4_096);
            const networkHost = isRecord(parameters.networkApprovalContext)
                ? optionalText(parameters.networkApprovalContext.host, 500)
                : undefined;
            const amendment = codexExecpolicyAmendment(parameters);
            return {
                ...approvalFields(id, parameters),
                kind,
                ...(amendment && { alwaysAllowPrefix: codexAmendmentPrefix(amendment) }),
                ...(command && { command }),
                ...(cwd && { cwd }),
                ...(networkHost && { networkHost }),
            };
        }
        case 'fileChange': {
            return { ...approvalFields(id, parameters), kind };
        }
        case 'question': {
            const questions = Array.isArray(parameters.questions) ? parameters.questions : [];
            return {
                id,
                kind,
                questions: questions.slice(0, MAX_AGENT_CHAT_QUESTIONS).flatMap((question) => {
                    if (!isRecord(question) || typeof question.id !== 'string') return [];
                    const options = Array.isArray(question.options) ? question.options : [];
                    return [
                        {
                            id: clip(question.id, 200),
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
                            allowsOther: question.isOther === true,
                        },
                    ];
                }),
            };
        }
    }
}

/**
 * `turn/plan/updated`: the turn's step list, replacing any earlier plan.
 */
export function mapCodexPlan(parameters: Json, turnId: string | undefined): AgentChatPlan {
    const steps = Array.isArray(parameters.plan) ? parameters.plan : [];
    const explanation = optionalText(parameters.explanation, 2_000);
    return {
        turnId: clip(turnId ?? '', 200),
        ...(explanation && { explanation }),
        steps: steps.slice(0, MAX_AGENT_CHAT_PLAN_STEPS).flatMap((step) =>
            isRecord(step)
                ? [
                      {
                          step: clip(text(step.step), 1_000),
                          status:
                              step.status === 'completed' || step.status === 'inProgress'
                                  ? step.status
                                  : 'pending',
                      },
                  ]
                : [],
        ),
    };
}

/**
 * `thread/tokenUsage/updated`: the last request's token count against the model context window, with what it was made
 * of. Output already includes reasoning, so reasoning is not listed as a row of its own. `cacheTtlMinutes` comes from
 * the sign-in (`codexCacheTtlMinutes`); without one the composer shows no cache expiry.
 */
export function mapCodexUsage(
    parameters: Json,
    model: string | undefined,
    cacheTtlMinutes: number | undefined,
    now = Date.now(),
): AgentChatSnapshot['usage'] {
    const usage = isRecord(parameters.tokenUsage) ? parameters.tokenUsage : undefined;
    const last = isRecord(usage?.last) ? usage.last : undefined;
    const totalTokens = optionalNumber(last?.totalTokens);
    if (totalTokens === undefined || totalTokens < 0) return undefined;
    const contextWindow = optionalNumber(usage?.modelContextWindow);
    const input = Math.max(optionalNumber(last?.inputTokens) ?? 0, 0);
    const cached = Math.min(Math.max(optionalNumber(last?.cachedInputTokens) ?? 0, 0), input);
    const output = Math.max(optionalNumber(last?.outputTokens) ?? 0, 0);
    const breakdown = [
        { label: 'Cached input', tokens: Math.trunc(cached) },
        { label: 'New input', tokens: Math.trunc(input - cached) },
        { label: 'Output', tokens: Math.trunc(output) },
    ].filter((row) => row.tokens > 0);
    return withCacheRewriteEstimate(
        {
            totalTokens: Math.trunc(totalTokens),
            ...(contextWindow !== undefined &&
                contextWindow >= 0 && { contextWindow: Math.trunc(contextWindow) }),
            ...(breakdown.length > 0 && { breakdown }),
            ...(cacheTtlMinutes !== undefined && { cacheTtlMinutes }),
            lastResponseAt: now,
        },
        model,
    );
}

/**
 * Codex's `codexErrorInfo` failures it retries, by Caxri's closed retry cause. A variant with a payload (an HTTP
 * status) arrives as an object keyed by its name.
 */
const CODEX_RETRY_CAUSES: Partial<Record<string, RetryCause>> = {
    httpConnectionFailed: 'connection',
    responseStreamConnectionFailed: 'connection',
    responseStreamDisconnected: 'connection',
    rateLimitExceeded: 'rateLimit',
    serverOverloaded: 'overloaded',
    internalServerError: 'server',
};

/**
 * Codex words a retry as `Reconnecting... 2/5` and puts the failure in `additionalDetails`.
 */
const CODEX_RETRY_COUNT = /^Reconnecting\.{3} (\d+)\/(\d+)$/u;

function codexRetry(error: Json | undefined): {
    retry: NonNullable<Extract<AgentChatItem, { type: 'notice' }>['retry']>;
    message: string | undefined;
} {
    const info = error?.codexErrorInfo;
    const name = isRecord(info) ? Object.keys(info)[0] : optionalText(info, 200);
    const message = optionalText(error?.message, 2_000);
    const details = optionalText(error?.additionalDetails, 2_000);
    const count = message ? CODEX_RETRY_COUNT.exec(message) : null;
    const retry = {
        cause: (name === undefined ? undefined : CODEX_RETRY_CAUSES[name]) ?? 'other',
        ...(count && { attempt: Number(count[1]), maxAttempts: Number(count[2]) }),
    } as const;
    return { retry, message: count ? details : (message ?? details) };
}

/**
 * The `error` notification: a retry notice while Codex retries, else the turn's error notice. One item per kind and
 * turn, so a repeated retry updates the notice instead of stacking copies.
 */
export function mapCodexErrorNotice(
    parameters: Json,
    turnId: string | undefined,
    usageLimit?: AgentChatUsageLimit,
): AgentChatItem {
    const error = isRecord(parameters.error) ? parameters.error : undefined;
    const base = { ...(turnId && { turnId: clip(turnId, 200) }), type: 'notice' } as const;
    if (parameters.willRetry === true) {
        const { retry, message } = codexRetry(error);
        return {
            id: `${turnId ?? 'thread'}:retrying`,
            ...base,
            kind: 'retrying',
            retry,
            ...(message && { message }),
        };
    }
    const message = optionalText(error?.message, 2_000);
    return {
        id: `${turnId ?? 'thread'}:error`,
        ...base,
        kind: 'error',
        ...(message && { message }),
        ...(usageLimit && { usageLimit }),
    };
}
