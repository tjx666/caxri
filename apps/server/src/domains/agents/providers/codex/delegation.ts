import { CaxriError } from '@caxri/protocol';
import { expandLaunchArguments } from '@caxri/utils';
import { coerce, gte } from 'semver';

import type {
    AgentDelegationAdapter,
    DelegationCompletion,
    DelegationEvidence,
} from '../../delegation-contract';
import { replaceDelegationArguments, validateDelegationArguments } from '../../delegation-contract';
import type { AgentLifecycleSignal } from '../../hooks/contract';
import { extractCodexDelegationUsage } from './delegation-usage';

const valueFlags = new Set(['--model', '--sandbox', '--ask-for-approval', '-c', '--config']);
const booleanFlags = new Set([
    '--search',
    '--no-alt-screen',
    '--dangerously-bypass-approvals-and-sandbox',
]);

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * Stop hooks may block and continue the same Codex turn. Only the persisted terminal event proves its final answer; the
 * authenticated UserPromptSubmit already bound the exact turn to the private task pointer.
 *
 * @see https://github.com/openai/codex/blob/fc7d34ad/codex-rs/core/src/tasks/mod.rs
 * @see https://github.com/openai/codex/blob/fc7d34ad/codex-rs/core/src/session/turn.rs
 */
export function extractCodexDelegationCompletion(
    content: string,
    evidence: DelegationEvidence,
): DelegationCompletion | undefined {
    if (!evidence.turnId) return;
    let completion: DelegationCompletion | undefined;
    for (const line of content.split('\n')) {
        let row: Record<string, unknown> | undefined;
        try {
            row = object(JSON.parse(line));
        } catch {
            continue;
        }
        if (row?.type !== 'event_msg') continue;
        const event = object(row.payload);
        if (!event || event.turn_id !== evidence.turnId) continue;
        if (!['task_complete', 'turn_complete', 'turn_aborted'].includes(String(event.type)))
            continue;
        if (completion) return { kind: 'failed', failure: 'correlation_missing' };
        if (event.type === 'turn_aborted') {
            completion = { kind: 'failed', failure: 'provider_failed' };
            continue;
        }
        if (event.error !== undefined && event.error !== null) {
            const code = object(event.error)?.codex_error_info;
            const failures = {
                rate_limit_exceeded: 'rate_limited',
                unauthorized: 'authentication_failed',
                usage_limit_exceeded: 'quota_exhausted',
                session_budget_exceeded: 'quota_exhausted',
                context_window_exceeded: 'output_limit',
            } as const;
            completion = {
                kind: 'failed',
                failure:
                    typeof code === 'string' && Object.hasOwn(failures, code)
                        ? failures[code as keyof typeof failures]
                        : 'provider_failed',
            };
        } else if (
            typeof event.last_agent_message !== 'string' ||
            event.last_agent_message.length === 0
        ) {
            completion = { kind: 'failed', failure: 'result_missing' };
        } else {
            completion = {
                kind: 'answer',
                text: event.last_agent_message,
                messageId: evidence.turnId,
            };
        }
    }
    return completion;
}

/**
 * Only failure kinds {@link extractCodexDelegationCompletion} derives from an explicit provider error
 * (`event.error`/`codex_error_info`) or an explicit `turn_aborted` are mapped: both are unambiguous evidence the turn
 * did not succeed. `result_missing` (Stop fired but the rollout has no matching completion text and no error) and
 * `correlation_missing` (more than one completion event for the same turn id) describe a read or correlation gap, not a
 * proven provider error, so they intentionally have no entry: {@link codexPrimaryTurnFailure} must leave the signal as
 * the ordinary `turnFinished` it already is rather than report a failure it cannot prove.
 */
const PRIMARY_TURN_FAILURE_BY_DELEGATION_FAILURE: Partial<
    Record<
        Extract<DelegationCompletion, { kind: 'failed' }>['failure'],
        NonNullable<AgentLifecycleSignal['agentFailure']>
    >
> = {
    rate_limited: 'rate_limit',
    authentication_failed: 'authentication_failed',
    quota_exhausted: 'billing_error',
    output_limit: 'max_output_tokens',
    provider_failed: 'provider_failed',
};

/**
 * Generalizes {@link extractCodexDelegationCompletion}'s rollout-JSONL correlation from the delegated/subagent path to
 * the primary Session's own `Stop` hook. `codex/hooks.ts` has no StopFailure-class binding (unlike Claude's and Grok's
 * own `hooks.ts`), so a login expiry or rate limit during the primary turn still fires a plain `Stop` and would
 * otherwise be recorded as `turnFinished`/`completed` (issue caxri#1345). `sessionId` and `promptDigest` are required
 * by {@link DelegationEvidence} but unused by this extractor, which only correlates on `turnId`.
 */
export function codexPrimaryTurnFailure(
    content: string,
    turnId: string,
): AgentLifecycleSignal['agentFailure'] | undefined {
    const completion = extractCodexDelegationCompletion(content, {
        turnId,
        sessionId: '',
        promptDigest: '',
    });
    if (completion?.kind !== 'failed') return undefined;
    return PRIMARY_TURN_FAILURE_BY_DELEGATION_FAILURE[completion.failure];
}

export const codexDelegationAdapter: AgentDelegationAdapter = {
    extractUsage: extractCodexDelegationUsage,
    completion: 'native-completion',
    createSessionId: () => {},
    validateLaunch: (launch) => {
        validateDelegationArguments(launch, valueFlags, booleanFlags);
        const arguments_ = expandLaunchArguments(launch.args);
        for (let index = 0; index < arguments_.length; index++) {
            const argument = arguments_[index];
            const flag = argument.split('=', 1)[0];
            if (flag !== '-c' && flag !== '--config') continue;
            const value = argument.includes('=')
                ? argument.slice(flag.length + 1)
                : arguments_[++index];
            if (
                !/^model_reasoning_effort=(?:low|medium|high|xhigh|max|ultra|"(?:low|medium|high|xhigh|max|ultra)")$/u.test(
                    value,
                )
            )
                throw new CaxriError(
                    'CONFLICT',
                    'Only model reasoning effort may be configured for delegation',
                );
        }
    },
    selectLaunch: (launch, selection) =>
        replaceDelegationArguments(launch, new Set(['--model', '-c', '--config']), [
            ...(selection.model ? ['--model', selection.model] : []),
            ...(selection.effort
                ? ['-c', `model_reasoning_effort=${JSON.stringify(selection.effort)}`]
                : []),
        ]),
    verifyVersion: (source) => {
        const version = coerce(source ?? '');
        if (version?.major !== 0 || !gte(version, '0.153.4'))
            throw new CaxriError(
                'UNAVAILABLE',
                'Visible delegation requires Codex CLI 0.153.4+ within major 0',
            );
    },
    /**
     * Codex add-dir grants write access; a read-only task pointer must not add that grant.
     */
    freshLaunch: (launch, pointer) => ({ ...launch, args: [...launch.args, '--', pointer] }),
    resumeLaunch: (launch) => launch,
    extractCompletion: extractCodexDelegationCompletion,
};
