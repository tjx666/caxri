import type {
    AgentChatDecision,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatPlan,
    AgentChatRequest,
    AgentChatSnapshot,
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

import { clip, isRecord, tail } from './chat-items';
import { withCacheRewriteEstimate } from './chat-usage';

/**
 * Pure translation from Codex app-server v2 `ThreadItem`s and server requests into the provider-neutral Agent Chat
 * projection. Inputs are untrusted JSON, so every field is read defensively and every string is bounded.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs
 */

type Json = Record<string, unknown>;

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
 * User inputs that are references rather than text; the Chat shows their name in brackets.
 */
const REFERENCE_INPUT_TYPES = new Set<unknown>(['mention', 'skill']);

const IMAGE_INPUT_TYPES = new Set<unknown>(['image', 'localImage']);

/**
 * How many images a user message carried. Codex echoes the full image (a data URL or a local path), which is never
 * copied into the projection; the session pairs a message it sent with the thumbnails the Client made.
 */
function codexUserImageCount(content: unknown): number {
    if (!Array.isArray(content)) return 0;
    return content.filter((input) => isRecord(input) && IMAGE_INPUT_TYPES.has(input.type)).length;
}

function userMessageText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content
        .flatMap((input) => {
            if (!isRecord(input)) return [];
            if (input.type === 'text') return [text(input.text)];
            if (REFERENCE_INPUT_TYPES.has(input.type))
                return [`[${text(input.name) || text(input.path)}]`];
            return [];
        })
        .join('\n');
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
 * A subagent tool call (`spawnAgent`, `sendInput`, `wait`, `closeAgent`, ...). The summary is the prompt it sent, or
 * how many agents it addressed; the output is the final messages the target agents reported, such as a `wait` result.
 */
function mapCollabAgentToolCall(raw: Json, base: { id: string; turnId?: string }): AgentChatItem {
    const receivers = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds.length : 0;
    const summary =
        optionalText(raw.prompt, 1_000) ??
        (receivers > 0 ? `${receivers} agent${receivers === 1 ? '' : 's'}` : undefined);
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
 * `turn/plan/updated`; review markers and hook prompts are not conversation content).
 */
export function mapCodexItem(
    raw: unknown,
    turnId: string | undefined,
    isStreaming: boolean,
): AgentChatItem | undefined {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return undefined;
    const base = { id: clip(raw.id, 200), ...(turnId && { turnId: clip(turnId, 200) }) };
    switch (raw.type) {
        case 'userMessage': {
            const imageCount = Math.min(codexUserImageCount(raw.content), MAX_AGENT_CHAT_IMAGES);
            return {
                ...base,
                type: 'userMessage',
                text: clip(userMessageText(raw.content), MAX_AGENT_CHAT_TEXT_LENGTH),
                ...(imageCount > 0 && { images: Array.from({ length: imageCount }, () => ({})) }),
            };
        }
        case 'agentMessage': {
            return {
                ...base,
                type: 'agentMessage',
                text: clip(text(raw.text), MAX_AGENT_CHAT_TEXT_LENGTH),
                streaming: isStreaming,
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
            const summary = summarizeJson(raw.arguments);
            return {
                ...base,
                type: 'toolCall',
                name: clip(text(raw.tool) || 'tool', 200),
                status: itemStatus(raw.status),
                ...(summary && { summary }),
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
            return mapCollabAgentToolCall(raw, base);
        }
        case 'subAgentActivity': {
            const name = SUB_AGENT_ACTIVITY_NAMES[text(raw.kind)];
            if (!name) return undefined;
            const summary = optionalText(raw.agentPath, 1_000);
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

const SIMPLE_DECISIONS = new Set<AgentChatDecision>([
    'accept',
    'acceptForSession',
    'decline',
    'cancel',
]);

/**
 * Fields every approval shares. Codex lists `availableDecisions` for prompts that must not offer every choice; only the
 * plain decisions are kept (policy amendments carry payloads Caxri does not offer), and an absent list means all.
 */
function approvalFields(id: string, parameters: Json) {
    const itemId = optionalText(parameters.itemId, 200);
    const reason = optionalText(parameters.reason, 2_000);
    const decisions = Array.isArray(parameters.availableDecisions)
        ? parameters.availableDecisions.filter(
              (decision): decision is AgentChatDecision =>
                  typeof decision === 'string' &&
                  SIMPLE_DECISIONS.has(decision as AgentChatDecision),
          )
        : undefined;
    return {
        id,
        ...(itemId && { itemId }),
        ...(reason && { reason }),
        ...(decisions?.length && { decisions: [...new Set(decisions)] }),
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
            return {
                ...approvalFields(id, parameters),
                kind,
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
 * How long Codex's prompt cache is assumed to survive an idle Chat, in minutes. OpenAI keeps cached prefixes for a
 * variable time (minutes in memory, longer under extended retention) and reports neither the policy nor an expiry, so
 * this is an estimate that only drives the composer's cache hint.
 *
 * @see https://developers.openai.com/api/docs/guides/prompt-caching
 */
const CODEX_CACHE_TTL_MINUTES = 30;

/**
 * `thread/tokenUsage/updated`: the last request's token count against the model context window, with what it was made
 * of. Output already includes reasoning, so reasoning is not listed as a row of its own.
 */
export function mapCodexUsage(
    parameters: Json,
    model: string | undefined,
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
            cacheTtlMinutes: CODEX_CACHE_TTL_MINUTES,
            lastResponseAt: now,
        },
        model,
    );
}

/**
 * The `error` notification: a retry notice while Codex retries, else the turn's error notice. One item per kind and
 * turn, so a repeated retry updates the notice instead of stacking copies.
 */
export function mapCodexErrorNotice(parameters: Json, turnId: string | undefined): AgentChatItem {
    const message = isRecord(parameters.error)
        ? optionalText(parameters.error.message, 2_000)
        : undefined;
    const kind = parameters.willRetry === true ? 'retrying' : 'error';
    return {
        id: `${turnId ?? 'thread'}:${kind}`,
        ...(turnId && { turnId: clip(turnId, 200) }),
        type: 'notice',
        kind,
        ...(message && { message }),
    };
}
