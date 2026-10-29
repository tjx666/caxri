import type {
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTurnUsage,
} from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

import type { UsageTokens } from './accumulator';
import { estimateResponseUsd } from './pricing';
import { contextFloorK } from './record';

/**
 * Responses of one turn whose usage is remembered so a repeated report adds only its growth; far above what one turn
 * makes, so only a runaway loop could evict one and count its repeat twice.
 */
const MAX_TRACKED_RESPONSES = 2_048;

export interface ChatTurnResponse {
    /**
     * Identifies the response across repeated reports (Claude Code repeats a message's `usage` on every content block
     * frame); absent when each report is its own response.
     */
    id?: string;
    model: string | undefined;
    tokens: UsageTokens;
    /**
     * `priority` when the response ran in Codex Fast mode, which bills a multiple of the standard price.
     */
    serviceTier?: 'priority';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function promptTokens({ input, cacheRead, cacheWrite }: UsageTokens): number {
    return input + cacheRead + cacheWrite;
}

/**
 * One Claude Code assistant frame's response, main thread or subagent. The SDK repeats a message's growing `usage` on
 * each of its content block frames, so the message id keeps them one response, as the Usage page's transcript parser
 * does.
 */
export function claudeTurnResponse(message: unknown): ChatTurnResponse | undefined {
    if (!isRecord(message) || !isRecord(message.usage)) return undefined;
    const { usage } = message;
    const model = typeof message.model === 'string' ? message.model : undefined;
    if (model === '<synthetic>') return undefined;
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const creation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
    return {
        ...(typeof message.id === 'string' && { id: message.id }),
        model,
        tokens: {
            input: count(usage.input_tokens),
            output: count(usage.output_tokens),
            cacheRead: count(usage.cache_read_input_tokens),
            cacheWrite,
            cacheWrite1h: Math.min(cacheWrite, count(creation?.ephemeral_1h_input_tokens)),
            reasoning: 0,
        },
    };
}

/**
 * One Codex request from `thread/tokenUsage/updated`. `last` is that request's own usage, with cached input inside
 * `inputTokens`; the thread's running `total`, when reported, names the response, so a repeated notification for the
 * same request adds nothing. A subagent runs in a thread of its own whose running `total` can equal the parent's, so
 * `threadId` scopes that name to the reporting thread.
 */
export function codexTurnResponse(
    parameters: Record<string, unknown>,
    model: string | undefined,
    isFast: boolean,
    threadId?: string,
): ChatTurnResponse | undefined {
    const usage = isRecord(parameters.tokenUsage) ? parameters.tokenUsage : undefined;
    const last = isRecord(usage?.last) ? usage.last : undefined;
    const total = isRecord(usage?.total) ? usage.total : undefined;
    if (!last) return undefined;
    const totalTokens = count(total?.totalTokens);
    const input = count(last.inputTokens);
    const cached = Math.min(count(last.cachedInputTokens), input);
    return {
        ...(totalTokens > 0 && { id: `${threadId ? `${threadId}:` : ''}total:${totalTokens}` }),
        model,
        tokens: {
            input: input - cached,
            output: count(last.outputTokens),
            cacheRead: cached,
            cacheWrite: 0,
            cacheWrite1h: 0,
            reasoning: count(last.reasoningOutputTokens),
        },
        ...(isFast && { serviceTier: 'priority' as const }),
    };
}

/**
 * Sums what the active turn spends as its model responses arrive, for the composer strip. A response is counted once
 * however many times it is reported, and each report adds only its growth. The figures start over when a response
 * arrives for another turn. While a goal is active, the same growth also adds to the snapshot's `goalUsage`, which
 * carries across turns, since the provider starts the goal's turns on its own and the user follows the goal rather than
 * any one of them. It starts over for another objective, and the reducer drops it with a cleared goal, so the same
 * objective set again counts from zero.
 */
export class ChatTurnUsage {
    private current: AgentChatTurnUsage | undefined;
    private readonly responses = new Map<string, UsageTokens>();

    /**
     * Folds one response report into `turnId`'s figures, returning the state operation to apply, or `undefined` when
     * the report adds nothing or no turn is active.
     */
    add(
        turnId: string | undefined,
        response: ChatTurnResponse | undefined,
        { goal, goalUsage }: Pick<AgentChatSnapshot, 'goal' | 'goalUsage'> = {},
    ): AgentChatPatchOperation | undefined {
        if (!turnId || !response) return undefined;
        if (this.current?.turnId !== turnId) {
            this.current = { turnId, requests: 0, totalTokens: 0 };
            this.responses.clear();
        }
        const previous = response.id === undefined ? undefined : this.responses.get(response.id);
        const reported = previous ? { ...previous } : undefined;
        const growth = { ...response.tokens };
        for (const key of Object.keys(growth) as Array<keyof UsageTokens>) {
            growth[key] = Math.max(0, response.tokens[key] - (reported?.[key] ?? 0));
            if (reported) reported[key] = Math.max(reported[key], response.tokens[key]);
        }
        const tokens = promptTokens(growth) + growth.output;
        // A first report without tokens is not a response yet; its next report counts it.
        if (tokens === 0) return undefined;
        if (response.id !== undefined)
            rememberBounded(
                this.responses,
                response.id,
                reported ?? { ...response.tokens },
                MAX_TRACKED_RESPONSES,
            );
        const cost = response.model
            ? estimateResponseUsd(growth, response.model, {
                  contextFloorK: contextFloorK(promptTokens(reported ?? response.tokens)),
                  ...(response.serviceTier && { serviceTier: response.serviceTier }),
              })
            : undefined;
        const costUsd =
            cost === undefined ? this.current.costUsd : (this.current.costUsd ?? 0) + cost;
        const requests = reported ? 0 : 1;
        this.current = {
            turnId,
            requests: this.current.requests + requests,
            totalTokens: this.current.totalTokens + tokens,
            ...(costUsd !== undefined && { costUsd }),
        };
        if (goal?.status !== 'active') return { op: 'state', state: { turnUsage: this.current } };
        const spent = goalUsage?.objective === goal.objective ? goalUsage : undefined;
        const goalCostUsd = cost === undefined ? spent?.costUsd : (spent?.costUsd ?? 0) + cost;
        return {
            op: 'state',
            state: {
                turnUsage: this.current,
                goalUsage: {
                    objective: goal.objective,
                    requests: (spent?.requests ?? 0) + requests,
                    totalTokens: (spent?.totalTokens ?? 0) + tokens,
                    ...(goalCostUsd !== undefined && { costUsd: goalCostUsd }),
                },
            },
        };
    }

    /**
     * Adds one response to the host's active turn and applies what changed.
     */
    record(
        host: {
            read: () => Pick<AgentChatSnapshot, 'activeTurnId' | 'goal' | 'goalUsage'>;
            apply: (operations: AgentChatPatchOperation[]) => void;
        },
        response: ChatTurnResponse | undefined,
    ): void {
        const snapshot = host.read();
        const operation = this.add(snapshot.activeTurnId, response, snapshot);
        if (operation) host.apply([operation]);
    }
}
