import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

import { agentDelegationUsageSchema, CaxriError } from '@caxri/protocol';

import type {
    AgentDelegationAdapter,
    DelegationCompletion,
    DelegationEvidence,
} from '../../delegation-contract';
import { replaceDelegationArguments, validateDelegationArguments } from '../../delegation-contract';
import { isGrokVersionSupported } from './hooks';

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * Grok persists the final outcome with its native prompt identity. Stop hooks can continue work, so only this durable
 * event proves finality. Grok can merge rejected drafts with the final response, so the authenticated final Stop's byte
 * length and digest select an exact suffix. agent_result is error detail, never an answer. Live response boundary
 * events are not persisted and cannot delimit this read. Clipped Stop text cannot authenticate a complete answer.
 *
 * @see https://github.com/xai-org/grok-build/blob/37949780/crates/codegen/xai-grok-shell/src/extensions/notification.rs
 */
export function extractGrokDelegationCompletion(
    content: string,
    evidence: DelegationEvidence,
): DelegationCompletion | undefined {
    if (!evidence.turnId) return;
    let completion: DelegationCompletion | undefined;
    let chunks = '';
    let stopCount = 0;
    let isStopAllowed = false;
    for (const line of content.split('\n')) {
        let row: Record<string, unknown> | undefined;
        try {
            row = object(JSON.parse(line));
        } catch {
            continue;
        }
        if (row?.method !== '_x.ai/session/update' && row?.method !== 'session/update') continue;
        const parameters = object(row.params);
        if (parameters?.sessionId !== evidence.sessionId) continue;
        const update = object(parameters.update);
        if (completion) {
            if (update?.sessionUpdate === 'turn_completed' && update.prompt_id === evidence.turnId)
                return { kind: 'failed', failure: 'correlation_missing' };
            continue;
        }
        if (
            row.method === '_x.ai/session/update' &&
            update?.sessionUpdate === 'hook_execution' &&
            update.event_name === 'stop' &&
            update.prompt_id === evidence.turnId
        ) {
            stopCount++;
            isStopAllowed =
                Array.isArray(update.runs) &&
                update.runs.length > 0 &&
                update.runs.every((run) => {
                    const status = object(object(run)?.status);
                    return (
                        status?.status === 'success' ||
                        status?.status === 'skipped' ||
                        (status?.status === 'failed' && status.blocked === false)
                    );
                });
            continue;
        }
        if (
            row.method === 'session/update' &&
            ['user_message_chunk', 'tool_call', 'tool_call_update'].includes(
                String(update?.sessionUpdate),
            )
        ) {
            chunks = '';
            continue;
        }
        if (row.method === 'session/update' && update?.sessionUpdate === 'agent_message_chunk') {
            const content = object(update.content);
            if (content?.type === 'text' && typeof content.text === 'string')
                chunks += content.text;
            continue;
        }
        if (update?.sessionUpdate !== 'turn_completed' || update.prompt_id !== evidence.turnId)
            continue;
        const counters = object(update.usage);
        const parsed =
            counters?.usageIsIncomplete === true
                ? undefined
                : agentDelegationUsageSchema.safeParse({
                      source: 'provider',
                      scope: 'provider-task',
                      inputTokens: counters?.inputTokens,
                      outputTokens: counters?.outputTokens,
                      cacheReadTokens: counters?.cachedReadTokens,
                      cacheWriteTokens: counters?.cacheCreationTokens,
                      reasoningTokens: counters?.reasoningTokens,
                      totalTokens: counters?.totalTokens,
                  });
        const usage = parsed?.success ? parsed.data : undefined;
        const bytes = Buffer.from(chunks);
        const length = evidence.answerByteLength;
        const answer =
            length !== undefined &&
            length > 0 &&
            length <= bytes.length &&
            (bytes[bytes.length - length] & 0xc0) !== 0x80
                ? bytes.subarray(bytes.length - length).toString('utf8')
                : undefined;
        if (
            (update.error_kind !== undefined && update.error_kind !== null) ||
            update.stop_reason !== 'end_turn'
        ) {
            const failures = {
                rate_limit: 'rate_limited',
                rate_limited: 'rate_limited',
                auth: 'authentication_failed',
                max_tokens_truncation: 'output_limit',
                max_tokens: 'output_limit',
            } as const;
            const reason =
                typeof update.error_kind === 'string' ? update.error_kind : update.stop_reason;
            completion = {
                kind: 'failed',
                failure:
                    typeof reason === 'string' && Object.hasOwn(failures, reason)
                        ? failures[reason as keyof typeof failures]
                        : 'provider_failed',
                usage,
            };
        } else if (evidence.answerOverflow) {
            completion = { kind: 'failed', failure: 'payload_overflow', usage };
        } else if (
            !isStopAllowed ||
            length === undefined ||
            !evidence.answerDigest ||
            stopCount !== evidence.answerStopCount
        ) {
            completion = { kind: 'failed', failure: 'correlation_missing', usage };
        } else if (!answer) {
            completion = { kind: 'failed', failure: 'result_missing', usage };
        } else if (createHash('sha256').update(answer).digest('hex') !== evidence.answerDigest) {
            completion = { kind: 'failed', failure: 'correlation_missing', usage };
        } else {
            completion = {
                kind: 'answer',
                text: answer,
                messageId: evidence.turnId,
                usage,
            };
        }
    }
    return completion;
}

export const grokDelegationAdapter: AgentDelegationAdapter = {
    completion: 'native-completion',
    completionRequiresTranscript: true,
    createSessionId: randomUUID,
    validateLaunch: (launch) =>
        validateDelegationArguments(
            launch,
            new Set([
                '--model',
                '-m',
                '--reasoning-effort',
                '--effort',
                '--sandbox',
                '--permission-mode',
                '--tools',
                '--disallowed-tools',
                '--allow',
                '--deny',
                '--max-turns',
            ]),
            new Set([
                '--no-alt-screen',
                '--minimal',
                '--fullscreen',
                '--disable-web-search',
                '--always-approve',
            ]),
        ),
    selectLaunch: (launch, selection) =>
        replaceDelegationArguments(
            launch,
            new Set(['--model', '-m', '--reasoning-effort', '--effort']),
            [
                ...(selection.model ? ['--model', selection.model] : []),
                ...(selection.effort ? ['--reasoning-effort', selection.effort] : []),
            ],
        ),
    verifyVersion: (source) => {
        if (!isGrokVersionSupported(source))
            throw new CaxriError(
                'UNAVAILABLE',
                'Visible delegation requires Grok Build 1.0.24+ within major 1',
            );
    },
    extractCompletion: extractGrokDelegationCompletion,
};
